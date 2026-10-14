/**
 * Issue Orchestration — Hermes Desktop plugin (self-contained, no host half)
 *
 * Browse, create and close issues in one GitHub repo, filter by the repo's
 * labels, and see parent issues with a sub-issue progress count.
 *
 * TOKEN: pasted once on the setup screen and kept in this app's plugin storage
 * on THIS PC (plaintext; see the security notes on the setup screen). It is sent
 * only to https://api.github.com, on every request (GitHub's REST API has no
 * session — each call carries the Authorization header). It never goes to the
 * Hermes host or the agent.
 *
 * Windows: %LOCALAPPDATA%\hermes\desktop-plugins\github-issues\plugin.js
 * Ctrl+K → Reload desktop plugins
 */
import {
  Button,
  Checkbox,
  cn,
  haptic,
  host,
  Input,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  Textarea,
  atom,
  useTheme,
  useValue
} from '@hermes/plugin-sdk'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ===== CORE BEGIN (pure logic, no SDK imports — exercised by an offline node test) =====
const ID = 'github-issues'
const ROUTE = '/github-issues'
const WORKSPACE_ID = 'github-issues'
const STORE_REPO = 'repo'
const STORE_TOKEN = 'token'
const STORE_SUBFILTER = 'subFilter'
const STORE_INCLUDE_SUB = 'prefIncludeSub'
const STORE_COLLAPSE_SUBS = 'prefCollapseSubs'
const STORE_PAGE_SIZE = 'prefPageSize'
const STORE_DOCK = 'prefDockPanel'
const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 100 // GitHub's per-page limit
const API = 'https://api.github.com'

let CTX = null
function setCtx(c) {
  CTX = c
}

/** A usable page size from whatever was typed or stored: a whole number 1..100, else null. */
function parsePageSize(v) {
  const t = String(v === undefined || v === null ? '' : v).trim()
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= MAX_PAGE_SIZE ? n : null
}

/** User preferences (Settings). The two list checkboxes default to TRUE, the page size to 10 and the docked right-side panel to OFF until the user changes them. */
function readPrefs() {
  const on = k => !CTX || CTX.storage.get(k, true) !== false
  const size = CTX ? parsePageSize(CTX.storage.get(STORE_PAGE_SIZE, DEFAULT_PAGE_SIZE)) : null
  return { includeSub: on(STORE_INCLUDE_SUB), collapseSubs: on(STORE_COLLAPSE_SUBS), pageSize: size || DEFAULT_PAGE_SIZE, dock: !!CTX && CTX.storage.get(STORE_DOCK, false) === true }
}

function writePrefs(prefs) {
  CTX.storage.set(STORE_INCLUDE_SUB, !!prefs.includeSub)
  CTX.storage.set(STORE_COLLAPSE_SUBS, !!prefs.collapseSubs)
  CTX.storage.set(STORE_PAGE_SIZE, parsePageSize(prefs.pageSize) || DEFAULT_PAGE_SIZE)
  CTX.storage.set(STORE_DOCK, !!prefs.dock)
}

/** owner/name, https://github.com/owner/name(.git)(/…), git@github.com:owner/name.git */
function parseRepo(input) {
  let s = String(input || '').trim()
  if (!s) return null
  s = s.replace(/^git@github\.com:/i, '').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
  s = s.replace(/[?#].*$/, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const repo = parts[0] + '/' + parts[1].replace(/\.git$/i, '')
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null
}

// github_pat_… (fine-grained) and ghp_… (classic) are letters, digits and underscores.
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/
function tokenProblem(t) {
  return TOKEN_RE.test(t)
    ? null
    : 'That does not look like a GitHub token (letters, digits and underscores only, no spaces or line breaks).'
}

class GhError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

function ghMessage(status, detail, headers) {
  if (status === 401) return 'GitHub rejected the token (401). It may be expired, revoked or mistyped — open Settings to replace it.'
  if ((status === 403 || status === 429) && headers.get('x-ratelimit-remaining') === '0') {
    return 'GitHub rate limit reached. Try again in a few minutes.'
  }
  if (status === 403) return 'The token lacks permission for this action (403). It needs Issues: Read and write on this repo. ' + detail
  if (status === 404) {
    return 'Not found (404). The repo may not exist, or this token cannot see it — a fine-grained token only sees the repos you selected when you created it.'
  }
  if (status === 410) return 'Issues are disabled for this repository.'
  if (status === 422) return 'GitHub rejected the request (422). ' + detail
  return 'GitHub error ' + status + '. ' + detail
}

async function gh(method, path, opts) {
  const o = opts || {}
  const tok = o.token || (CTX && CTX.storage.get(STORE_TOKEN, ''))
  if (!tok) throw new GhError('No GitHub token saved. Open Settings to add one.', 0)
  let url = API + path
  if (o.query) {
    const qs = new URLSearchParams()
    for (const k of Object.keys(o.query)) {
      const v = o.query[k]
      if (v !== undefined && v !== '') qs.set(k, String(v))
    }
    const s = qs.toString()
    if (s) url += '?' + s
  }
  const headers = {
    Authorization: 'Bearer ' + tok,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (o.body !== undefined) headers['Content-Type'] = 'application/json'
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    })
  } catch (e) {
    throw new GhError('Could not reach api.github.com. Check your connection.', 0)
  }
  if (res.ok) {
    const t = await res.text()
    return { data: t ? JSON.parse(t) : null, headers: res.headers }
  }
  let detail = ''
  try {
    detail = (await res.json()).message || ''
  } catch (e) {}
  throw new GhError(ghMessage(res.status, detail, res.headers), res.status)
}

function slimIssue(i) {
  const s = i.sub_issues_summary || {}
  return {
    id: i.id,
    number: i.number,
    node_id: i.node_id || '',
    title: i.title || '',
    body: i.body || '',
    state: i.state,
    state_reason: i.state_reason || null,
    url: i.html_url,
    author: (i.user && i.user.login) || '',
    comments: i.comments || 0,
    created_at: i.created_at,
    closed_at: i.closed_at,
    labels: (i.labels || [])
      .filter(l => l && typeof l === 'object')
      .map(l => ({ name: l.name, color: l.color || 'ededed', description: l.description || '' })),
    is_sub: !!i.parent_issue_url,
    sub_total: s.total || 0,
    sub_done: s.completed || 0
  }
}

/** Check token + repo together. Returns repo info and, for classic tokens, a warning. */
async function verifyConnection(repo, token) {
  const r = await gh('GET', '/repos/' + repo, { token })
  const info = r.data
  if (info.has_issues === false) throw new GhError('Issues are disabled for this repository.', 410)
  let login = ''
  try {
    login = ((await gh('GET', '/user', { token })).data || {}).login || ''
  } catch (e) {}
  // X-OAuth-Scopes is only sent for classic tokens.
  const scopes = r.headers.get('x-oauth-scopes')
  let warning = null
  if (scopes !== null) {
    warning = /(^|,\s*)repo(\s*,|$)/.test(scopes)
      ? 'This is a classic token with the full "repo" scope — it can read and write all your repositories. Replace it with a fine-grained token limited to this one repo.'
      : 'This is a classic token. A fine-grained token limited to one repo is safer.'
  }
  return { repo: info.full_name, private: !!info.private, login, warning }
}

async function listLabels(repo) {
  let all = []
  for (let page = 1; page <= 10; page++) {
    const r = await gh('GET', '/repos/' + repo + '/labels', { query: { per_page: 100, page } })
    all = all.concat(r.data || [])
    if ((r.data || []).length < 100) break
  }
  return all.map(l => ({ name: l.name, color: l.color || 'ededed', description: l.description || '' }))
}

/** One page of the plain issue list (state only). Used when the search box holds just its default text and sub-issues are included; every
 *  other case goes through searchIssues (which also reports a total). `total` is not known here (null) — the caller uses the tab counts. */
async function listIssues(repo, o) {
  const r = await gh('GET', '/repos/' + repo + '/issues', {
    query: { state: o.state, per_page: o.perPage, page: o.page, sort: o.sort || 'created', direction: o.order || 'desc' }
  })
  const rows = r.data || []
  const issues = rows.filter(i => !i.pull_request).map(slimIssue)
  return { issues, page: o.page, total: null, has_more: rows.length === o.perPage }
}

// ---- the search bar. Its text is GitHub's own search syntax. The bar always shows `is:issue state:<open|closed>`; the list the user
// is looking at decides the state, so those tokens (and is:open / is:closed) are not "terms". Everything else is passed to GitHub
// search as typed (words, label:"x", author:, in:title, no:label, ...). repo:/org:/user: are dropped: the plugin works on one repo.
function queryTokens(text) {
  return String(text || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []
}

function defaultQuery(state) {
  return 'is:issue state:' + state
}

/** { state: 'open'|'closed'|null (the last state token typed), terms: the rest, space-joined } */
function parseQuery(text) {
  let state = null
  const terms = []
  for (const t of queryTokens(text)) {
    const low = t.toLowerCase()
    if (low === 'is:issue') continue
    const m = /^(?:state|is):(open|closed)$/.exec(low)
    if (m) {
      state = m[1]
      continue
    }
    if (/^-?(?:repo|org|user):/.test(low)) continue
    terms.push(t)
  }
  return { state, terms: terms.join(' ') }
}

/** The page buttons to show: 1, the last page and two either side of the current one; a gap of a single page shows that page instead of "…". */
function pageWindow(current, count) {
  if (count <= 1) return [1]
  const keep = new Set([1, count])
  for (let i = current - 2; i <= current + 2; i++) if (i >= 1 && i <= count) keep.add(i)
  const nums = [...keep].sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < nums.length; i++) {
    if (i > 0) {
      const gap = nums[i] - nums[i - 1]
      if (gap === 2) out.push(nums[i] - 1)
      else if (gap > 2) out.push('…')
    }
    out.push(nums[i])
  }
  return out
}

/** Splits the search text into pieces for colouring: the part of each `qualifier:value` phrase AFTER the first colon is `hl`. Every
 *  character of the text ends up in exactly one piece (so the pieces joined give the text back — the overlay must line up with the input). */
function highlightParts(text) {
  const s = String(text || '')
  const out = []
  const re = /(\s+)|((?:[^\s"]+|"[^"]*(?:"|$))+)/g
  let m
  while ((m = re.exec(s))) {
    if (m[1]) {
      out.push({ t: m[1], hl: false })
      continue
    }
    const tok = m[2]
    const c = /^[^:"\s]+:/.exec(tok)
    if (c && tok.length > c[0].length) {
      out.push({ t: c[0], hl: false })
      out.push({ t: tok.slice(c[0].length), hl: true })
    } else out.push({ t: tok, hl: false })
  }
  return out
}

/** Keeps the locked front of the search text (`is:issue state:open` / `state:closed`) intact. `prev` is the text before the edit, `next` what
 *  the box would hold after it. The edit is located by diffing the two, so typing, deleting, cutting and pasting are all covered:
 *    - the edit is entirely inside the locked prefix  -> ignored
 *    - the edit starts in the prefix and runs past it  -> the prefix stays, only the part after it is replaced
 *    - the edit is after the prefix                    -> accepted
 *    - a whole query pasted over the box (starting `is:issue state:...`) -> its front folds into the locked one, its terms are kept
 *  A space always separates the prefix from what follows. Returns the accepted text and where the caret should go. */
function guardQuery(prev, next, prefix) {
  const P = prefix.length
  if (!String(prev).startsWith(prefix)) {
    const t = String(next).startsWith(prefix) ? next : prefix + ' ' + String(next).trimStart()
    return { text: t, caret: t.length }
  }
  if (!String(next).startsWith(prefix)) {
    // A whole query pasted over the box ("is:issue state:closed nas"): its own front folds into the locked one; the terms are kept.
    const m = /^is:issue state:(?:open|closed)(?=\s|$)/.exec(next)
    if (m) next = prefix + next.slice(m[0].length)
  }
  if (next === prev) return { text: prev, caret: prev.length }
  const max = Math.min(prev.length, next.length)
  let a = 0
  while (a < max && prev[a] === next[a]) a++
  let b = 0
  while (b < max - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++
  const start = a
  const end = prev.length - b
  const ins = next.slice(a, next.length - b)
  let text
  let caret
  if (start >= P) {
    text = next
    caret = a + ins.length
  } else if (end <= P) {
    return { text: prev, caret: prev.length } // inside the locked part: nothing happens
  } else {
    const sep = ins && !/^\s/.test(ins) ? ' ' : ''
    text = prev.slice(0, P) + sep + ins + prev.slice(end)
    caret = P + sep.length + ins.length
  }
  if (text.length > P && !/\s/.test(text[P])) {
    text = text.slice(0, P) + ' ' + text.slice(P)
    if (caret >= P) caret += 1
  }
  return { text, caret }
}

/** The label pills live IN the search text as label:<name> tokens (quoted when the name has spaces). */
function labelToken(name) {
  const n = String(name).replace(/"/g, '')
  return /[\s:]/.test(n) ? 'label:"' + n + '"' : 'label:' + n
}

/** Names of the labels currently in the search text (lower-cased, for comparing). */
function queryLabels(text) {
  const out = []
  for (const t of queryTokens(text)) {
    const m = /^label:(?:"([^"]*)"|(.+))$/i.exec(t)
    if (m) out.push((m[1] !== undefined ? m[1] : m[2]).toLowerCase())
  }
  return out
}

/** Click a label pill: add its label:<name> token (one space after the existing text), or take it out if it is already there. */
function toggleLabelInQuery(text, name) {
  const low = String(name).toLowerCase()
  if (queryLabels(text).includes(low)) {
    return queryTokens(text)
      .filter(t => {
        const m = /^label:(?:"([^"]*)"|(.+))$/i.exec(t)
        return !(m && (m[1] !== undefined ? m[1] : m[2]).toLowerCase() === low)
      })
      .join(' ')
  }
  return String(text || '').replace(/\s+$/, '') + ' ' + labelToken(name)
}

/** Clear ALL label filtering: every label:<name> token goes (quoted or not, and the negated -label:<name> form too), so labels typed by hand are
 *  cleared as well as clicked ones. Everything else — the locked front, free words, other qualifiers — stays. */
function clearLabelsInQuery(text) {
  return queryTokens(text)
    .filter(t => !/^-?label:/i.test(t))
    .join(' ')
}

/** Take a lone issue-number token (`#20`) out of the search text — the way out of the single-issue view. Everything else stays. */
function dropIssueNumber(text) {
  return queryTokens(text)
    .filter(t => !/^#\d+$/.test(t))
    .join(' ')
}

/** The same text pointed at another list: every state token is rewritten (is:open -> is:closed, state:open -> state:closed). */
function withState(text, state) {
  return String(text || '').replace(/(^|\s)(state|is):(open|closed)(?=\s|$)/gi, (all, sp, key) => sp + key + ':' + state)
}

// Sorting of the lists (the bar's Sort menu). `by`: created | updated; `order`: desc = Newest first, asc = Oldest first. Remembered while the
// plugin stays loaded (the page is rebuilt when you visit Settings and come back).
const SORT_BY_OPTIONS = [
  ['created', 'Created on'],
  ['updated', 'Last updated']
]
const SORT_MEMO = { by: 'created', order: 'desc' }
const isDefaultSort = sort => sort.by === 'created' && sort.order === 'desc'

const SEARCH_RESULT_CAP = 1000 // GitHub only serves the first 1000 search results

/** Search the repo's issues with free-form terms (plus the tab's state, label pills and the sub-issue setting). */
async function searchIssues(repo, o) {
  const q = ['repo:' + repo, 'is:issue', 'is:' + o.state]
  if (!o.includeSub) q.push('no:parent-issue')
  q.push(o.terms)
  const query = { q: q.join(' '), per_page: o.perPage, page: o.page }
  if (!/(?:^|\s)sort:/i.test(o.terms)) {
    query.sort = o.sort || 'created'
    query.order = o.order || 'desc'
  }
  let r
  try {
    r = await gh('GET', '/search/issues', { query })
  } catch (e) {
    if (e.status === 422) throw new GhError('GitHub could not understand that search. Check the qualifiers (for example label:"good first issue").', 422)
    throw e
  }
  const total = (r.data && r.data.total_count) || 0
  const issues = ((r.data && r.data.items) || []).filter(i => !i.pull_request).map(slimIssue)
  const reachable = Math.min(total, SEARCH_RESULT_CAP)
  return { issues, page: o.page, total: reachable, has_more: o.page * o.perPage < reachable }
}

// ---- pinned issues. These are GitHub's OWN pins (the same ones github.com shows at the top of the Issues page): shared, limited by GitHub to 3 per
// repository, and set through GraphQL (there is no REST endpoint). Closing an issue does not un-pin it.
const MAX_PINS = 3

/** `{ number, state, state_reason, ... }` shaped like slimIssue, from a GraphQL issue node. */
function slimGraphIssue(n) {
  return {
    id: n.databaseId || 0,
    number: n.number,
    node_id: n.id,
    title: n.title || '',
    body: '',
    state: String(n.state || '').toLowerCase(),
    state_reason: n.stateReason ? String(n.stateReason).toLowerCase() : null,
    url: n.url,
    author: '',
    comments: 0,
    created_at: null,
    closed_at: null,
    labels: ((n.labels && n.labels.nodes) || []).map(l => ({ name: l.name, color: l.color || 'ededed', description: l.description || '' })),
    is_sub: false,
    sub_total: 0,
    sub_done: 0
  }
}

async function listPinnedIssues(repo) {
  const [owner, name] = String(repo).split('/')
  const data = await ghGraphql(
    'query($o:String!,$n:String!){repository(owner:$o,name:$n){pinnedIssues(first:' + MAX_PINS + '){nodes{issue{id databaseId number title state stateReason url labels(first:5){nodes{name color description}}}}}}}',
    { o: owner, n: name }
  )
  const nodes = (data && data.repository && data.repository.pinnedIssues && data.repository.pinnedIssues.nodes) || []
  return nodes.filter(x => x && x.issue).map(x => slimGraphIssue(x.issue))
}

function pinError(e, verb) {
  const m = String((e && e.message) || e || '')
  if (/Maximum 3 pinned/i.test(m)) return 'GitHub allows at most ' + MAX_PINS + ' pinned issues per repository. Un-pin one first.'
  if (/not pinned/i.test(m)) return 'That issue is not pinned any more.'
  return m || 'Could not ' + verb + ' the issue.'
}

async function pinIssue(repo, issue) {
  if (!issue || !issue.node_id) throw new GhError('Missing issue id — press Refresh and try again.', 0)
  try {
    await ghGraphql('mutation($id:ID!){pinIssue(input:{issueId:$id}){issue{number}}}', { id: issue.node_id })
  } catch (e) {
    throw new GhError(pinError(e, 'pin'), e.status || 0)
  }
}

async function unpinIssue(repo, issue) {
  try {
    await ghGraphql('mutation($id:ID!){unpinIssue(input:{issueId:$id}){issue{number}}}', { id: issue.node_id })
  } catch (e) {
    throw new GhError(pinError(e, 'un-pin'), e.status || 0)
  }
}

/** One issue by number, as a slim issue — or null when there is no such issue. (Used for the exact `#N` lookup.) */
async function getIssueSlim(repo, number) {
  try {
    const r = await gh('GET', '/repos/' + repo + '/issues/' + number)
    const i = r.data
    return i && !i.pull_request ? slimIssue(i) : null
  } catch (e) {
    if (e.status === 404 || e.status === 410) return null
    throw e
  }
}

/** The issue number when the search terms are exactly one `#N` (nothing else): that means "show me issue N", looked up directly. Otherwise null. */
function lonelyIssueNumber(terms) {
  const m = /^#(\d{1,9})$/.exec(String(terms || '').trim())
  return m ? Number(m[1]) : null
}

async function createIssue(repo, o) {
  const payload = { title: o.title.trim() }
  if (o.body && o.body.trim()) payload.body = o.body
  if (o.labels && o.labels.length) payload.labels = o.labels
  return slimIssue((await gh('POST', '/repos/' + repo + '/issues', { body: payload })).data)
}

/**
 * reason: 'completed' | 'not_planned' | 'duplicate'.
 * completed / not_planned use REST. duplicate must go through GraphQL: REST accepts
 * state_reason "duplicate" but silently ignores duplicate_of, so no link is recorded.
 * `issue` is the slim issue being closed; `dupOf` (slim issue) is required for duplicate.
 */
async function closeIssue(repo, issue, reason, dupOf) {
  if (reason !== 'duplicate') {
    const body = { state: 'closed', state_reason: reason }
    return slimIssue((await gh('PATCH', '/repos/' + repo + '/issues/' + issue.number, { body })).data)
  }
  if (!dupOf || !dupOf.node_id) throw new GhError('Pick the issue this duplicates.', 0)
  if (dupOf.number === issue.number) throw new GhError('An issue cannot be a duplicate of itself.', 0)
  if (!issue.node_id) throw new GhError('Missing issue id — press Refresh and try again.', 0)
  const query =
    'mutation($id:ID!,$dup:ID!){closeIssue(input:{issueId:$id,stateReason:DUPLICATE,duplicateIssueId:$dup}){issue{number state stateReason}}}'
  const r = await gh('POST', '/graphql', { body: { query, variables: { id: issue.node_id, dup: dupOf.node_id } } })
  const errs = r.data && r.data.errors
  if (errs && errs.length) throw new GhError('GitHub rejected the request: ' + (errs[0].message || 'unknown error'), 422)
  const out = r.data && r.data.data && r.data.data.closeIssue && r.data.data.closeIssue.issue
  if (!out) throw new GhError('GitHub returned no result for the close request.', 502)
  return { number: out.number, state: 'closed', state_reason: 'duplicate' }
}

/** Candidates for "duplicate of": #N lookup, text search, or the most recent issues when blank. */
async function findDuplicateCandidates(repo, query, selfNumber) {
  const q = String(query || '').trim()
  let items = []
  if (/^#?\d+$/.test(q)) {
    try {
      const r = await gh('GET', '/repos/' + repo + '/issues/' + q.replace('#', ''))
      if (!r.data.pull_request) items = [r.data]
    } catch (e) {
      if (e.status !== 404) throw e
    }
  } else if (q) {
    const r = await gh('GET', '/search/issues', {
      query: { q: q + ' repo:' + repo + ' is:issue', per_page: 10, sort: 'created', order: 'desc' }
    })
    items = (r.data && r.data.items) || []
  } else {
    const r = await gh('GET', '/repos/' + repo + '/issues', {
      query: { state: 'all', per_page: 12, sort: 'created', direction: 'desc' }
    })
    items = (r.data || []).filter(i => !i.pull_request)
  }
  return items.map(slimIssue).filter(i => i.number !== selfNumber)
}

/** Sub-issues of one parent (REST, up to 100). */
async function listSubIssues(repo, parentNumber) {
  const r = await gh('GET', '/repos/' + repo + '/issues/' + parentNumber + '/sub_issues', { query: { per_page: 100 } })
  return (r.data || []).map(slimIssue).filter(i => !isDeleted(i.number))
}

/** Create an issue, then link it under the parent (the link call wants the numeric issue id). */
async function createSubIssue(repo, parentNumber, o) {
  const created = await createIssue(repo, o)
  try {
    await gh('POST', '/repos/' + repo + '/issues/' + parentNumber + '/sub_issues', { body: { sub_issue_id: created.id } })
  } catch (e) {
    const err = new GhError('Issue #' + created.number + ' was created, but linking it under #' + parentNumber + ' failed: ' + e.message, e.status)
    err.created = created
    throw err
  }
  return Object.assign({}, created, { is_sub: true })
}

// ---- delete. GitHub has NO REST endpoint for this: the "Delete issue" link on github.com uses the GraphQL `deleteIssue` mutation,
// which needs admin on the repository. GitHub deletes only the one issue (its children survive as ordinary issues), so
// deleting "an issue and everything below it" is done here: collect the descendants, then delete them deepest-first.
async function ghGraphql(query, variables) {
  const tok = CTX && CTX.storage.get(STORE_TOKEN, '')
  if (!tok) throw new GhError('No GitHub token saved. Open Settings to add one.', 0)
  let res
  try {
    res = await fetch(API + '/graphql', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    })
  } catch (e) {
    throw new GhError('Could not reach api.github.com. Check your connection.', 0)
  }
  let json = null
  try {
    json = await res.json()
  } catch (e) {}
  if (!res.ok) throw new GhError(ghMessage(res.status, (json && json.message) || '', res.headers), res.status)
  if (json && json.errors && json.errors.length) {
    const e = json.errors[0]
    const forbidden = e.type === 'FORBIDDEN' || e.type === 'INSUFFICIENT_SCOPES' || /permission|admin/i.test(e.message || '')
    throw new GhError(
      forbidden ? 'GitHub refused: deleting an issue needs admin access to the repository. ' + (e.message || '') : e.message || 'GitHub returned an error.',
      forbidden ? 403 : 0
    )
  }
  return (json && json.data) || null
}

const MAX_DELETE = 300
const MAX_DEPTH = 8 // GitHub allows sub-issues up to 8 levels deep

/** Every issue below `issue` (children, grandchildren, ...), DEEPEST FIRST — the order they are deleted in. The issue itself is not
 *  included, and neither are its parent or siblings: a delete never reaches above the issue it was started on. */
async function collectDescendants(repo, issue) {
  const out = []
  const seen = new Set([issue.number])
  const walk = async (number, depth) => {
    if (depth > MAX_DEPTH) return
    const kids = await listSubIssues(repo, number)
    for (const k of kids) {
      if (seen.has(k.number)) continue
      seen.add(k.number)
      if (seen.size > MAX_DELETE) throw new GhError('That issue has more than ' + MAX_DELETE + ' issues below it. Delete them in smaller parts.', 0)
      // Always look, even if the list says 0 sub-issues: that summary can lag GitHub's real data, and a missed grandchild would be left behind.
      await walk(k.number, depth + 1)
      out.push(k)
    }
  }
  await walk(issue.number, 0)
  return out
}

/** Permanently delete `issue` and everything in `below` (from collectDescendants), one at a time, children before parents.
 *  Returns the deleted numbers. If one fails, the rest are left alone and the error carries `.deleted` (what already went). */
async function deleteIssueTree(issue, below, onProgress) {
  const all = below.concat(issue)
  const gone = []
  for (let i = 0; i < all.length; i++) {
    try {
      await ghGraphql('mutation($id:ID!){ deleteIssue(input:{issueId:$id}){ clientMutationId } }', { id: all[i].node_id })
    } catch (e) {
      noteDeleted(gone)
      const err = new GhError('Deleted ' + gone.length + ' of ' + all.length + ' and stopped at #' + all[i].number + ': ' + (e.message || e), e.status)
      err.deleted = gone
      throw err
    }
    gone.push(all[i].number)
    if (onProgress) onProgress(i + 1, all.length)
  }
  noteDeleted(gone)
  return gone
}

// ---- markdown-lite: a small, safe subset. Output is plain data (no HTML); the renderer builds
// React elements from it, so nothing from an issue body is ever injected as markup.
function safeHref(u) {
  return /^https?:\/\/[^\s<>"']+$/i.test(u) ? u : null
}

/** Inline tokens: code, links/images, bold, italic, bare URLs. Anything else stays literal text. */
function parseInline(text) {
  const out = []
  const re = /`([^`\n]+)`|!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|(https?:\/\/[^\s<>"')\]]+)/g
  let last = 0
  let m
  const push = t => t && out.push({ t: 'text', text: t })
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push({ t: 'code', text: m[1] })
    else if (m[3] !== undefined) {
      const href = safeHref(m[3])
      const label = m[2] || m[3]
      if (href) out.push({ t: 'a', href, text: m[0][0] === '!' ? 'image: ' + label : label })
      else push(m[0])
    } else if (m[4] !== undefined || m[5] !== undefined) out.push({ t: 'b', children: parseInline(m[4] !== undefined ? m[4] : m[5]) })
    else if (m[6] !== undefined || m[7] !== undefined) out.push({ t: 'i', children: parseInline(m[6] !== undefined ? m[6] : m[7]) })
    else if (m[8] !== undefined) out.push({ t: 'a', href: m[8], text: m[8] })
    last = m.index + m[0].length
  }
  push(text.slice(last))
  return out
}

/** Block structure: headings, paragraphs, bullet/numbered/task lists, fenced code, quotes, rules. */
function parseMarkdown(src) {
  const text = String(src || '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '')
  const lines = text.split('\n')
  const blocks = []
  let para = []
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', inline: parseInline(para.join('\n')) })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m
    if ((m = /^\s*(```|~~~)/.exec(line))) {
      flush()
      const fence = m[1]
      const buf = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++])
      blocks.push({ t: 'code', text: buf.join('\n') })
    } else if (!line.trim()) {
      flush()
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flush()
      blocks.push({ t: 'h', level: m[1].length, inline: parseInline(m[2]) })
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      blocks.push({ t: 'hr' })
    } else if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) {
      flush()
      const prev = blocks[blocks.length - 1]
      if (prev && prev.t === 'quote') prev.lines.push(m[1])
      else blocks.push({ t: 'quote', lines: [m[1]] })
    } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flush()
      const ordered = /\d/.test(m[2])
      const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3])
      const item = { inline: parseInline(task ? task[2] : m[3]), depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '    ').length / 2)) }
      if (task) item.checked = task[1] !== ' '
      const prev = blocks[blocks.length - 1]
      if (prev && prev.t === 'list' && prev.ordered === ordered) prev.items.push(item)
      else blocks.push({ t: 'list', ordered, items: [item] })
    } else {
      para.push(line)
    }
  }
  flush()
  return blocks
}

/** Unlink a sub-issue from its parent. The issue is NOT deleted: it keeps its state and becomes top-level. */
/** Latest description + labels straight from GitHub (the list copy can be stale). */
async function fetchIssueDetail(repo, number) {
  const r = await gh('GET', '/repos/' + repo + '/issues/' + number)
  const i = r.data || {}
  const slim = slimIssue(i)
  return { title: i.title || '', body: i.body || '', labels: slim.labels.map(l => l.name), labelObjs: slim.labels }
}

/** The editor's state from GitHub's current copy of an issue. Everything the form shows is pre-filled; `base*` is what it started from (to see
 *  what the user changed and whether someone else changed it meanwhile). */
function editFromDetail(d) {
  return { phase: 'edit', title: d.title, baseTitle: d.title, text: normBody(d.body), base: d.body, labels: d.labels.slice(), baseLabels: d.labels.slice() }
}

const EDIT_LOADING = { phase: 'loading', title: '', baseTitle: '', text: '', base: '', labels: [], baseLabels: [] }

/** Update an issue's title, description and/or labels. ONLY the fields present in `fields` are sent: GitHub replaces the
 *  whole label set (and the whole body) it is given, so sending an untouched field could undo someone else's change. */
async function updateIssueFields(repo, number, fields) {
  const body = {}
  if (fields.title !== undefined) {
    if (!String(fields.title).trim()) throw new GhError('The title cannot be empty.', 0)
    body.title = String(fields.title).trim()
  }
  if (fields.body !== undefined) body.body = fields.body
  if (fields.labels !== undefined) body.labels = fields.labels
  if (!Object.keys(body).length) throw new GhError('Nothing to save.', 0)
  return slimIssue((await gh('PATCH', '/repos/' + repo + '/issues/' + number, { body })).data)
}

/** Same set of label names, order ignored. */
function sameLabels(a, b) {
  const x = (a || []).slice().sort()
  const y = (b || []).slice().sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** Textareas hand back \n; GitHub may store \r\n. Compare on the normalised form. */
function normBody(t) {
  return String(t || '').replace(/\r\n?/g, '\n')
}

/** Move a sub-issue within its parent. Anchor is the neighbour to land after (`after`) or before (`before`). */
async function reorderSubIssue(repo, parentNumber, sub, pos) {
  const anchor = pos && (pos.after || pos.before)
  if (!sub || !sub.id || !anchor || !anchor.id) throw new GhError('Missing issue id — press Refresh and try again.', 0)
  if (anchor.id === sub.id) throw new GhError('Cannot move an issue relative to itself.', 0)
  const body = { sub_issue_id: sub.id }
  if (pos.after) body.after_id = anchor.id
  else body.before_id = anchor.id
  await gh('PATCH', '/repos/' + repo + '/issues/' + parentNumber + '/sub_issues/priority', { body })
}

/** Pure list move: returns the new order plus the neighbour to anchor against. */
function planMove(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return null
  const next = list.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return to > 0 ? { next, moved, pos: { after: next[to - 1] } } : { next, moved, pos: { before: next[1] } }
}

/** Which sub-issues to list: 'all' = open and closed, 'open' = open only. */
function filterSubs(subs, mode) {
  return mode === 'open' ? subs.filter(x => x.state === 'open') : subs
}

/** Apply a move to the FULL list: put `moved` right after (pos.after) / before (pos.before) its anchor, as GitHub does.
 *  Needed because the list on screen may hide some sub-issues, so row positions are not positions in the full list. */
function applyPos(full, moved, pos) {
  const anchor = pos && (pos.after || pos.before)
  const rest = full.filter(x => x.number !== moved.number)
  const i = anchor ? rest.findIndex(x => x.number === anchor.number) : -1
  if (i < 0) return full
  rest.splice(pos.after ? i + 1 : i, 0, moved)
  return rest
}

/** Reopen a closed issue (GitHub records the reason as "reopened"). */
async function reopenIssue(repo, number) {
  return slimIssue((await gh('PATCH', '/repos/' + repo + '/issues/' + number, { body: { state: 'open', state_reason: 'reopened' } })).data)
}

// GitHub's single-issue endpoint is correct immediately, but its LIST endpoints lag a few seconds behind a
// write. So an issue the user just closed/reopened is remembered briefly and laid over the lists, otherwise
// "Reopen" would leave it missing from the Open tab (and still showing in Closed) for ~3 seconds.
// Which sub-issue is expanded under each parent ("repo#parent" -> sub-issue number). Module-level on purpose: it is remembered when
// the parent is collapsed and re-expanded, or the list is switched, for as long as the plugin is loaded.
const OPEN_SUB = new Map()
// Same idea for the other display state, so clicking Open / Closed (which rebuilds the list) does not reset it:
// ROW_OPEN = parent rows that are expanded; SECTION_COLLAPSED = a Sub-issues section the user collapsed (true) or expanded (false)
// by hand. A section nobody toggled follows the Settings default.
const ROW_OPEN = new Set()
const SECTION_COLLAPSED = new Map()
const RECENT = new Map()
const RECENT_MS = 8000

// Issues the user has just deleted. GitHub's list/search endpoints lag a few seconds behind a write, so a deleted issue could
// reappear in a freshly fetched list; this overlay hides it for a while.
const DELETED = new Map()
const DELETED_MS = 60000

function noteDeleted(numbers) {
  const until = Date.now() + DELETED_MS
  for (const n of numbers) DELETED.set(n, until)
}

function isDeleted(number, now) {
  const until = DELETED.get(number)
  if (until === undefined) return false
  if (until < (now === undefined ? Date.now() : now)) {
    DELETED.delete(number)
    return false
  }
  return true
}

function noteChange(issue, now) {
  RECENT.set(issue.number, { issue, until: (now === undefined ? Date.now() : now) + RECENT_MS })
}

/** For a search result: hide what was just deleted or just moved to the other state (GitHub's index lags a few seconds). */
function dropRecent(list, state, now) {
  const t = now === undefined ? Date.now() : now
  return list.filter(i => {
    if (isDeleted(i.number, t)) return false
    const e = RECENT.get(i.number)
    return !e || e.issue.state === state
  })
}

/** Apply recent local changes to a freshly fetched list of `state` issues. */
function applyRecent(list, state, includeSub, now) {
  const t = now === undefined ? Date.now() : now
  for (const [n, e] of RECENT) if (e.until < t) RECENT.delete(n)
  const out = list.filter(i => {
    if (isDeleted(i.number, t)) return false
    const e = RECENT.get(i.number)
    return !e || e.issue.state === state
  })
  for (const e of RECENT.values()) {
    const i = e.issue
    if (i.state === state && (includeSub || !i.is_sub) && !out.some(x => x.number === i.number)) out.unshift(i)
  }
  return out
}

/** Count issues of one state the way its list shows them: every issue when sub-issues are included, otherwise parent
 *  issues only (GitHub search qualifier `no:parent-issue`), narrowed by the search box's terms (which include any label:... tokens). */
async function countIssues(repo, state, includeSub, terms) {
  const q = ['repo:' + repo, 'is:issue', 'is:' + state]
  if (!includeSub) q.push('no:parent-issue')
  if (terms) q.push(terms)
  const r = await gh('GET', '/search/issues', { query: { q: q.join(' '), per_page: 1 } })
  return (r.data && r.data.total_count) || 0
}

async function fetchCounts(repo, includeSub, terms) {
  const [open, closed] = await Promise.all([countIssues(repo, 'open', includeSub, terms), countIssues(repo, 'closed', includeSub, terms)])
  return { open, closed }
}

function ago(iso) {
  if (!iso) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago'
  return 'on ' + new Date(iso).toLocaleDateString()
}

// Label pills, modelled on GitHub's: dark = tinted fill + tinted border + lightened text;
// light = solid fill with black/white text.
function hexToRgb(hex) {
  const h = String(hex || 'ededed').replace('#', '').padEnd(6, '0')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function rgbToHsl(r, g, b) {
  r /= 255
  g /= 255
  b /= 255
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  let h = 0
  let s = 0
  if (mx !== mn) {
    const d = mx - mn
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
  }
  return [h, s, l]
}
function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const f = (p, q, t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)].map(v => Math.round(v * 255))
}
function labelStyle(color, mode) {
  const [r, g, b] = hexToRgb(color)
  if (mode === 'light') {
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    return { backgroundColor: 'rgb(' + r + ',' + g + ',' + b + ')', color: lum > 0.6 ? '#1f2328' : '#ffffff', borderColor: 'transparent' }
  }
  const hsl = rgbToHsl(r, g, b)
  const t = hslToRgb(hsl[0], hsl[1], Math.min(0.85, hsl[2] + (1 - hsl[2]) * 0.4))
  return {
    backgroundColor: 'rgba(' + r + ',' + g + ',' + b + ',0.18)',
    color: 'rgb(' + t[0] + ',' + t[1] + ',' + t[2] + ')',
    borderColor: 'rgba(' + r + ',' + g + ',' + b + ',0.4)'
  }
}
// ===== CORE END =====

// ---------------------------------------------------------------- icons (Octicons, 16px)

const OCTOCAT_PATH =
  'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z'
const ISSUE_OPENED_PATH =
  'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z'
const ISSUE_CLOSED_PATH =
  'M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5ZM16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z'
const ISSUE_SKIPPED_PATH =
  'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z'
const LINK_PATH =
  'm7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z'
const ISSUE_REOPENED_PATH =
  'M5.029 2.217a6.5 6.5 0 0 1 9.437 5.11.75.75 0 1 0 1.492-.154 8 8 0 0 0-14.315-4.03L.427 1.927A.25.25 0 0 0 0 2.104V5.75A.25.25 0 0 0 .25 6h3.646a.25.25 0 0 0 .177-.427L2.715 4.215a6.491 6.491 0 0 1 2.314-1.998ZM1.262 8.169a.75.75 0 0 0-1.22.658 8.001 8.001 0 0 0 14.315 4.03l1.216 1.216a.25.25 0 0 0 .427-.177V10.25a.25.25 0 0 0-.25-.25h-3.646a.25.25 0 0 0-.177.427l1.358 1.358a6.501 6.501 0 0 1-11.751-3.11.75.75 0 0 0-.272-.506ZM9.5 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z'
const FILTER_PATH =
  'M.75 3h14.5a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1 0-1.5ZM3 7.75A.75.75 0 0 1 3.75 7h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 7.75Zm3 4a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z'
const CHECK_PATH =
  'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z'
const PENCIL_PATH =
  'M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z'
const TRASH_PATH =
  'M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z'
// Destructive-action colour (theme red, with a fallback).
const DANGER_COLOR = 'var(--ui-red, #f85149)'
const SEARCH_PATH =
  'M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z'
const CLEAR_PATH =
  'M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z'
const SYNC_PATH =
  'M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z'
// An 8-tooth gear with a round hub hole, generated geometrically (and rasterised to check it) rather than copied from memory.
const GEAR_PATH =
  'M6.18 3.13 L6.57 3.00 L6.53 0.44 L9.47 0.44 L9.43 3.00 L10.16 3.27 L10.52 3.45 L12.31 1.62 L14.38 3.69 L12.55 5.48 L12.87 6.18 L13.00 6.57 L15.56 6.53 L15.56 9.47 L13.00 9.43 L12.73 10.16 L12.55 10.52 L14.38 12.31 L12.31 14.38 L10.52 12.55 L9.82 12.87 L9.43 13.00 L9.47 15.56 L6.53 15.56 L6.57 13.00 L5.84 12.73 L5.48 12.55 L3.69 14.38 L1.62 12.31 L3.45 10.52 L3.13 9.82 L3.00 9.43 L0.44 9.47 L0.44 6.53 L3.00 6.57 L3.27 5.84 L3.45 5.48 L1.62 3.69 L3.69 1.62 L5.48 3.45ZM5.70 8.00a2.30 2.30 0 1 0 4.60 0a2.30 2.30 0 1 0 -4.60 0Z'
const SORT_DESC_PATH =
  'M1 2.5H9V4.1H1ZM1 6.5H6.5V8.1H1ZM1 10.5H4V12.1H1ZM12.2 2.5H13.8V10H12.2ZM9.6 9.4L16.4 9.4L13 13.6Z'
const SORT_ASC_PATH =
  'M1 2.5H4V4.1H1ZM1 6.5H6.5V8.1H1ZM1 10.5H9V12.1H1ZM12.2 6H13.8V13.5H12.2ZM9.6 6.6L16.4 6.6L13 2.4Z'
const PIN_PATH =
  'M4.5 0.9H11.5V2.6H4.5ZM5.6 2.6L10.4 2.6L10.9 7.2L5.1 7.2ZM3.2 7.2H12.8V8.9H3.2ZM7.2 8.9L8.8 8.9L8.8 12.6L8 15.4L7.2 12.6Z'
const KEBAB_PATH =
  'M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z'
const ARROW_RIGHT_PATH =
  'M8.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l2.97-2.97H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.03a.75.75 0 0 1 0-1.06Z'
const CHEVRON_DOWN_PATH =
  'M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z'
const CHEVRON_RIGHT_PATH =
  'M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z'
// 2 x 3 grid of dots (drawn explicitly so the columns are exactly aligned).
const GRIP_PATH =
  'M4.5 3.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0ZM9.5 3.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0ZM4.5 8a1 1 0 1 0 2 0a1 1 0 1 0-2 0ZM9.5 8a1 1 0 1 0 2 0a1 1 0 1 0-2 0ZM4.5 12.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0ZM9.5 12.5a1 1 0 1 0 2 0a1 1 0 1 0-2 0Z'
const ARROW_LEFT_PATH =
  'M7.78 12.53a.75.75 0 0 1-1.06 0L2.47 8.28a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L4.81 7h7.44a.75.75 0 0 1 0 1.5H4.81l2.97 2.97a.75.75 0 0 1 0 1.06Z'

// THE theme highlight colour: the app's per-theme primary (`--dt-primary`, i.e. Tailwind `bg-primary` — exactly what the
// default <Button>, like "Save" on the settings view and "New issue", is filled with).
// One constant feeds the "New issue" button, the parent-row icon and the expanded-row tint, so they always
// match each other and follow whichever theme is active. Falls back to the theme accent if a theme lacks it.

// GitHub's search index (used for the Open/Closed counts) trails a write by up to ~6s: after a local change the
// counts move at once, then are re-read once the index has caught up. Search allows 30 calls/min, so loads are
// debounced (each load is 2 calls).
const COUNT_REFETCH_MS = 7000
const COUNT_DEBOUNCE_MS = 300

const ACCENT_SOLID = 'var(--dt-primary, var(--ui-accent))'

// Issue-state colours. Theme variables, inline, with a fallback so the icon is never uncoloured.
const STATE_COLOR = {
  open: 'var(--ui-green, #3fb950)',
  closed: 'var(--ui-purple, #a371f7)',
  skipped: 'var(--ui-text-tertiary)'
}

function Icon({ path, size = 16, className, color }) {
  return jsx('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    fill: 'currentColor',
    'aria-hidden': 'true',
    focusable: 'false',
    className: cn('shrink-0', className),
    style: color ? { color } : undefined,
    children: jsx('path', { d: path })
  })
}

// `accent`: the header icon of a list row uses the theme highlight for OPEN issues instead of fixed green.
function IssueIcon({ issue, flat, accent }) {
  const m = flat ? '' : 'mt-0.5 '
  if (issue.state === 'open') return jsx(Icon, { path: ISSUE_OPENED_PATH, className: m, color: accent ? ACCENT_SOLID : STATE_COLOR.open })
  if (issue.state_reason === 'not_planned' || issue.state_reason === 'duplicate') {
    return jsx(Icon, { path: ISSUE_SKIPPED_PATH, className: m, color: STATE_COLOR.skipped })
  }
  return jsx(Icon, { path: ISSUE_CLOSED_PATH, className: m, color: STATE_COLOR.closed })
}

/** Link icon that opens an issue on GitHub. Swallows the click so it never toggles a row. */
function IssueLinkButton({ issue }) {
  return jsx('button', {
    type: 'button',
    title: 'Open #' + issue.number + ' on GitHub',
    'aria-label': 'Open #' + issue.number + ' on GitHub',
    className: 'inline-flex shrink-0 items-center rounded p-0.5 text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
    onClick: e => {
      e.stopPropagation()
      CTX.os.openExternal(issue.url)
    },
    children: jsx(Icon, { path: LINK_PATH, size: 14 })
  })
}

// Pills: 11px text, 16px line, exactly 1px borders = 18px tall. That is shorter than the 20px title line,
// so the title row is exactly one title line tall and the title centres on the 16px issue icon
// (2px top margin + 8px = 10px). All inline so no app class can change the size or border width.
// Fixed 18px box. Lower-case text centres ~1px BELOW the middle of a centred line box (the x-height sits
// under the line's centre), so 2px of bottom padding lifts it 1px and it reads as vertically centred.
const PILL_STYLE = {
  fontSize: '0.6875rem',
  lineHeight: '1rem',
  height: '1.125rem',
  boxSizing: 'border-box',
  paddingBottom: '2px',
  borderWidth: '1px',
  borderStyle: 'solid',
  // A pill never wraps its text and never shrinks: in a tight flex row it would otherwise collapse to its narrowest width and break
  // "0 / 1" across lines. The title next to it is what gives way (it truncates with an ellipsis).
  whiteSpace: 'nowrap',
  flexShrink: 0
}

// ---------------------------------------------------------------- small components

function LabelPill({ label, selected, onClick }) {
  const { resolvedMode } = useTheme()
  const style = { ...labelStyle(label.color, resolvedMode === 'light' ? 'light' : 'dark'), ...PILL_STYLE }
  if (selected) style.boxShadow = '0 0 0 2px var(--ui-accent)'
  return jsx(onClick ? 'button' : 'span', {
    type: onClick ? 'button' : undefined,
    onClick,
    title: label.description || label.name,
    'aria-pressed': onClick ? !!selected : undefined,
    className: cn(
      'inline-flex items-center rounded-full border px-2 font-semibold',
      onClick && 'cursor-pointer'
    ),
    style,
    children: label.name
  })
}

/** GitHub's "◔ 2 / 8" sub-issue progress chip. */
function SubIssuePill({ done, total }) {
  const C = 2 * Math.PI * 5.5
  const frac = total ? Math.min(1, done / total) : 0
  const complete = total > 0 && done >= total
  return jsxs('span', {
    title: done + ' of ' + total + ' sub-issues completed',
    style: PILL_STYLE,
    className:
      'inline-flex items-center gap-1 rounded-full border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-2 text-(--ui-text-secondary)',
    children: [
      // All done: the same completed check-circle used for a completed issue, in the completed colour.
      complete
        ? jsx(Icon, { path: ISSUE_CLOSED_PATH, size: 12, color: STATE_COLOR.closed })
        : jsxs('svg', {
            viewBox: '0 0 16 16',
            width: 12,
            height: 12,
            'aria-hidden': 'true',
            children: [
              jsx('circle', { cx: 8, cy: 8, r: 5.5, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.35, strokeWidth: 2 }),
              frac > 0
                ? jsx('circle', {
                    cx: 8,
                    cy: 8,
                    r: 5.5,
                    fill: 'none',
                    // Completed-issue colour (inline style: var() is reliable here, unlike a presentation attribute).
                    style: { stroke: STATE_COLOR.closed },
                    strokeWidth: 2,
                    strokeDasharray: frac * C + ' ' + C,
                    transform: 'rotate(-90 8 8)'
                  })
                : null
            ]
          }),
      done + ' / ' + total
    ]
  })
}

/** Sub-issues header chip: "1 of 2" with a pie that fills (completed-issue colour) as sub-issues close;
 *  when every sub-issue is complete it shows the completed check-circle instead of a full disc. */
function SubIssueCountPill({ done, total }) {
  const frac = total ? Math.min(1, done / total) : 0
  const complete = total > 0 && done >= total
  let pie = null
  if (!complete && frac > 0) {
    const ang = frac * 2 * Math.PI - Math.PI / 2
    const x = 8 + 4.5 * Math.cos(ang)
    const y = 8 + 4.5 * Math.sin(ang)
    pie = jsx('path', {
      d: 'M8 8 L8 3.5 A4.5 4.5 0 ' + (frac > 0.5 ? 1 : 0) + ' 1 ' + x.toFixed(3) + ' ' + y.toFixed(3) + ' Z',
      style: { fill: STATE_COLOR.closed }
    })
  }
  return jsxs('span', {
    title: done + ' of ' + total + ' sub-issues completed',
    style: PILL_STYLE,
    className:
      'inline-flex items-center gap-1.5 rounded-full border border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary) px-2 font-normal text-(--ui-text-secondary)',
    children: [
      complete
        ? jsx(Icon, { path: ISSUE_CLOSED_PATH, size: 12, color: STATE_COLOR.closed })
        : jsxs('svg', {
            viewBox: '0 0 16 16',
            width: 12,
            height: 12,
            'aria-hidden': 'true',
            children: [jsx('circle', { cx: 8, cy: 8, r: 6.25, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.4, strokeWidth: 1.5 }), pie]
          }),
      done + ' of ' + total
    ]
  })
}

// ---------------------------------------------------------------- setup / settings

const SECURITY_NOTES = [
  'Create a fine-grained token (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens). Under Repository access choose "Only select repositories" and pick just this repo.',
  'Grant only Repository permissions → Issues: Read and write. Metadata: Read is added automatically. Nothing else.',
  'Set an expiry (30–90 days). Avoid classic tokens, and never one with the broad "repo" scope.',
  "The token is saved in plaintext in this app's local plugin storage on this PC — not encrypted and not on your Hermes host. Anyone who can use your Windows profile, and any other Hermes Desktop plugin you enable, can read it. Only run plugins you trust.",
  "It is sent only to api.github.com, over HTTPS, with every request this plugin makes. It is never sent to the Hermes host or the agent. Don't paste it into chats or screenshots.",
  '"Remove saved token" clears it from this PC but does NOT revoke it. If the PC is lost or the token leaks, revoke it at github.com/settings/personal-access-tokens.'
]

/** A labelled checkbox row for the Settings screen (clicking the text toggles it). */
function PrefCheckbox({ id, checked, onChange, label, hint }) {
  return jsxs(
    'div',
    {
      className: 'flex items-start gap-2',
      children: [
        jsx(Checkbox, { id, checked, onCheckedChange: v => onChange(v === true), style: { marginTop: '0.125rem' } }),
        jsxs('label', {
          htmlFor: id,
          className: 'cursor-pointer text-xs text-(--ui-text-secondary)',
          children: [label, hint ? jsx('span', { className: 'block text-(--ui-text-quaternary)', children: hint }) : null]
        })
      ]
    },
    id
  )
}

// The app's input chrome (`.desktop-input-chrome`) lights a field up with the FULL ring colour while it is focused (7% at rest, 14% on hover,
// in dark themes). The plugin's forms — Settings, the issue edit box, the New issue form and the Create sub-issue form — keep a softened ACTIVE look
// permanently: the ring colour at 45%, no inset shadow, and so no roll state. Inline, so it beats the app's :hover and :focus rules (they carry no
// !important); built on the app's own theme variable so it follows every theme. One number to tune: FIELD_RING_STRENGTH.
const FIELD_RING_STRENGTH = '45%'
const FIELD_ACTIVE_STYLE = { borderColor: 'color-mix(in srgb, var(--dt-composer-ring) ' + FIELD_RING_STRENGTH + ', transparent)', boxShadow: 'none' }

function FieldInput(props) {
  return jsx(Input, { ...props, style: { ...props.style, ...FIELD_ACTIVE_STYLE } })
}

/** A textarea with the same permanent, softened active look (issue edit box, New issue and Create sub-issue forms). */
function FieldTextarea(props) {
  return jsx(Textarea, { ...props, style: { ...props.style, ...FIELD_ACTIVE_STYLE } })
}

// The plugin's quiet buttons (Settings: Cancel, Remove saved token, Show / Hide; the issue forms: Cancel). The app's ghost button is transparent until hovered (and its secondary
// button has its own softer fill); here the HOVER look —
// the app's own `--chrome-action-hover` fill and primary text colour — is the resting look, so the buttons read as buttons. The roll state moves
// one notch further (a little foreground mixed into that fill) so hovering still gives feedback. Inline style beats the app's :hover rule, which
// is why the hover step is tracked here. Disabled buttons stay at rest (and dimmed by the app's disabled style).
// Wide enough for either word (text-xs "Show" / "Hide" is ~30px) with the button's own padding, with room to spare.
const SHOW_HIDE_WIDTH = '4.5rem'
const GHOST_REST_BG = 'var(--chrome-action-hover)'
const GHOST_HOVER_BG = 'color-mix(in srgb, var(--foreground, currentColor) 7%, var(--chrome-action-hover))'

function QuietButton(props) {
  const [hover, setHover] = useState(false)
  const lit = hover && !props.disabled
  return jsx(Button, {
    ...props,
    variant: props.variant || 'ghost', // keeps the button's own size and shape; only the fill / text colour are set below
    style: { ...props.style, background: lit ? GHOST_HOVER_BG : GHOST_REST_BG, color: 'var(--ui-text-primary)' },
    onMouseEnter: e => {
      setHover(true)
      if (props.onMouseEnter) props.onMouseEnter(e)
    },
    onMouseLeave: e => {
      setHover(false)
      if (props.onMouseLeave) props.onMouseLeave(e)
    }
  })
}

function SetupScreen({ first, header, initialRepo, hasToken, onSaved, onCancel, onTokenRemoved }) {
  const leftMargin = useLeftMargin()
  const [repoIn, setRepoIn] = useState(initialRepo || '')
  const [tokenIn, setTokenIn] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  // Display preferences: edited here, written on Save (Cancel discards them).
  const [pref, setPref] = useState(readPrefs)
  const [pageSizeIn, setPageSizeIn] = useState(() => String(readPrefs().pageSize)) // kept as typed until Save validates it

  // With a token already saved the field is deliberately BLANK ("blank = keep the saved one"), so flipping it to plain text
  // would show nothing. Show therefore loads the saved token into the field (only on this explicit click); Hide takes it back
  // out again if it was not edited, returning to the blank "saved" state. An edited value is kept (masked).
  const toggleShow = () => {
    const saved = hasToken && CTX ? CTX.storage.get(STORE_TOKEN, '') : ''
    if (!show) {
      if (tokenIn === '' && saved) setTokenIn(saved)
      setShow(true)
    } else {
      if (saved && tokenIn === saved) setTokenIn('')
      setShow(false)
    }
  }

  const save = async () => {
    setError(null)
    const repo = parseRepo(repoIn)
    if (!repo) return setError('Enter a GitHub repository URL or owner/name.')
    const typed = tokenIn.trim()
    const token = typed || CTX.storage.get(STORE_TOKEN, '')
    if (!token) return setError('Paste a GitHub token.')
    if (typed && tokenProblem(typed)) return setError(tokenProblem(typed))
    if (!first && parsePageSize(pageSizeIn) === null) return setError('Number of issues per page must be a whole number from 1 to ' + MAX_PAGE_SIZE + '.')
    setBusy(true)
    try {
      const info = await verifyConnection(repo, token)
      // Persist only after GitHub accepted the token for this repo.
      CTX.storage.set(STORE_REPO, repo)
      if (typed) CTX.storage.set(STORE_TOKEN, typed)
      writePrefs({ ...pref, pageSize: parsePageSize(pageSizeIn) })
      bumpSync() // other mounted views (tab + docked panel) re-read; the dock registration follows the setting
      setTokenIn('')
      haptic('tap')
      onSaved({ repo, hasToken: true }, info.warning)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  // Settings (not first-time setup) sits under the same top nav as the list view: the page is a column with the left margin on the root, the
  // shared header on top (it never moves), and only the content below it scrolls. First-time setup keeps its own plain layout.
  return jsxs('div', {
    className: first ? 'h-full overflow-y-auto' : 'flex h-full min-h-0 flex-col',
    style: first ? undefined : { paddingLeft: leftMargin },
    children: [
      first ? null : header,
      jsx('div', {
        className: first ? undefined : 'min-h-0 flex-1 overflow-y-auto',
        children: jsxs('div', {
      // Full width (no centred max-width column): the page's left margin (clear of the nav) and the 1rem right margin the issue lists use.
      className: first ? 'space-y-4 py-5 pr-4' : 'space-y-4 pb-5 pr-4 pt-4',
      style: first ? { paddingLeft: leftMargin } : undefined,
      children: [
        first
          ? jsxs('div', {
              className: 'flex items-center gap-2',
              children: [
                jsx(Icon, { path: OCTOCAT_PATH, size: 22, className: 'text-(--ui-text-tertiary)' }),
                jsx('div', { className: 'text-base font-semibold', children: 'Connect to GitHub' })
              ]
            })
          : // Heading of the settings content (the page title above it is the shared top nav).
            jsx('div', { className: 'text-base font-semibold text-foreground', children: 'Settings' }),

        jsxs('div', {
          className: 'space-y-1.5',
          children: [
            jsx('label', { className: 'text-xs font-medium text-(--ui-text-secondary)', htmlFor: 'gi-repo', children: 'Repository' }),
            jsx(FieldInput, {
              id: 'gi-repo',
              value: repoIn,
              placeholder: 'https://github.com/owner/repo  or  owner/repo',
              autoComplete: 'off',
              spellCheck: false,
              onChange: e => setRepoIn(e.target.value),
              onKeyDown: e => e.key === 'Enter' && void save()
            }),
            jsx('div', {
              className: 'text-xs text-(--ui-text-quaternary)',
              children: 'You can change this any time. The token below must have access to whichever repo you pick.'
            })
          ]
        }),

        jsxs('div', {
          className: 'space-y-1.5',
          children: [
            jsx('label', { className: 'text-xs font-medium text-(--ui-text-secondary)', htmlFor: 'gi-token', children: 'Personal access token' }),
            jsxs('div', {
              className: 'flex gap-2',
              children: [
                jsx(FieldInput, {
                  id: 'gi-token',
                  type: show ? 'text' : 'password',
                  value: tokenIn,
                  placeholder: hasToken ? 'A token is saved — leave blank to keep it' : 'github_pat_…',
                  autoComplete: 'off',
                  spellCheck: false,
                  onChange: e => setTokenIn(e.target.value),
                  onKeyDown: e => e.key === 'Enter' && void save()
                }),
                jsx(QuietButton, {
                  type: 'button',
                  variant: 'secondary',
                  'aria-pressed': show,
                  // One fixed width for both words, so the button (and the input beside it) does not change size when it flips Show <-> Hide.
                  style: { width: SHOW_HIDE_WIDTH, flex: 'none' },
                  onClick: toggleShow,
                  children: show ? 'Hide' : 'Show'
                })
              ]
            })
          ]
        }),

        jsxs('div', {
          className: 'space-y-2 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary) p-3',
          children: [
            jsx('div', { className: 'text-xs font-semibold text-foreground', children: 'Before you paste a token — security' }),
            jsx('ul', {
              className: 'list-disc space-y-1.5 pl-4 text-xs text-(--ui-text-secondary)',
              children: SECURITY_NOTES.map((n, i) => jsx('li', { key: i, children: n }))
            })
          ]
        }),

        // Display preferences (Settings only — not shown on first-time setup).
        !first
          ? jsxs('div', {
              className: 'space-y-2',
              children: [
                jsx('div', { className: 'text-xs font-medium text-(--ui-text-secondary)', children: 'Display' }),
                PrefCheckbox({
                  id: 'gi-pref-include-sub',
                  checked: pref.includeSub,
                  onChange: v => setPref(p => ({ ...p, includeSub: v })),
                  label: 'Include sub-issues in Open and Closed lists',
                  hint: 'Unchecked: both lists show parent issues only (sub-issues stay inside their parent).'
                }),
                PrefCheckbox({
                  id: 'gi-pref-collapse-subs',
                  checked: pref.collapseSubs,
                  onChange: v => setPref(p => ({ ...p, collapseSubs: v })),
                  label: 'Collapse sub-issues by default when viewing a parent issue',
                  hint: 'Unchecked: the Sub-issues section is open as soon as you expand a parent.'
                }),
                jsxs('div', {
                  className: 'space-y-1.5 pt-1',
                  children: [
                    jsxs('div', {
                      className: 'flex items-center gap-3',
                      children: [
                        jsx('label', { className: 'text-xs text-(--ui-text-secondary)', htmlFor: 'gi-pref-page-size', children: 'Number of issues to display per page' }),
                        jsx(FieldInput, {
                          id: 'gi-pref-page-size',
                          value: pageSizeIn,
                          inputMode: 'numeric',
                          autoComplete: 'off',
                          'aria-describedby': 'gi-pref-page-size-hint',
                          style: { width: '4rem', flex: 'none' },
                          onChange: e => setPageSizeIn(e.target.value),
                          onKeyDown: e => e.key === 'Enter' && void save()
                        })
                      ]
                    }),
                    jsx('div', { id: 'gi-pref-page-size-hint', className: 'text-xs text-(--ui-text-quaternary)', children: 'A whole number from 1 to ' + MAX_PAGE_SIZE + ' (default ' + DEFAULT_PAGE_SIZE + '). More issues than this are split into pages below the list.' })
                  ]
                })
              ]
            })
          : null,

        // Docked panel (Settings only).
        !first
          ? jsxs('div', {
              className: 'space-y-2',
              children: [
                jsx('div', { className: 'text-xs font-medium text-(--ui-text-secondary)', children: 'Docked panel' }),
                PrefCheckbox({
                  id: 'gi-pref-dock',
                  checked: pref.dock,
                  onChange: v => setPref(p => ({ ...p, dock: v })),
                  label: 'Keep Issue Orchestration docked in a right-side panel',
                  hint: 'Checked: the panel is always there on the right, from the moment Desktop starts. Unchecked: it is removed. It cannot be closed from its tab while on — turn this off to remove it. Takes effect when you click Save.'
                })
              ]
            })
          : null,

        error ? jsx('div', { role: 'alert', className: 'whitespace-pre-wrap text-xs text-(--ui-red)', children: error }) : null,

        jsxs('div', {
          className: 'flex flex-wrap items-center gap-2',
          children: [
            jsx(Button, {
              type: 'button',
              disabled: busy,
              onClick: () => void save(),
              children: busy ? 'Verifying with GitHub…' : first ? 'Verify & save' : 'Save'
            }),
            !first ? jsx(QuietButton, { type: 'button', disabled: busy, onClick: onCancel, children: 'Cancel' }) : null,
            hasToken && !confirmRemove
              ? jsx(QuietButton, { type: 'button', className: 'ml-auto', onClick: () => setConfirmRemove(true), children: 'Remove saved token' })
              : null,
            hasToken && confirmRemove
              ? jsxs('span', {
                  className: 'ml-auto flex items-center gap-2 text-xs',
                  children: [
                    'Remove it from this PC?',
                    jsx(Button, {
                      type: 'button',
                      size: 'sm',
                      onClick: () => {
                        CTX.storage.remove(STORE_TOKEN)
                        bumpSync()
                        onTokenRemoved()
                      },
                      children: 'Remove'
                    }),
                    jsx(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: () => setConfirmRemove(false), children: 'Keep' })
                  ]
                })
              : null
          ]
        })
      ]
    })
      })
    ]
  })
}

// ---------------------------------------------------------------- issue list

const CLOSE_REASONS = {
  // Not a close reason: the "Edit" row that sits at the top of the ⋯ menu (it reuses MenuRow).
  edit: { title: 'Edit', icon: PENCIL_PATH },
  // Pin / un-pin (GitHub's own pinned issues). "Pin issue" sits under Edit; the pinned cards' menu holds only "Un-pin".
  pin: { title: 'Pin issue', icon: PIN_PATH },
  unpin: { title: 'Un-pin', icon: PIN_PATH },
  // The red Delete row at the bottom of the menu (opens the confirmation pane, see DeletePane).
  delete: { title: 'Delete issue…', icon: TRASH_PATH, color: DANGER_COLOR, titleColor: DANGER_COLOR },
  reopen: {
    title: 'Reopen issue',
    desc: '',
    icon: ISSUE_REOPENED_PATH,
    color: STATE_COLOR.open
  },
  completed: {
    title: 'Close as completed',
    desc: 'Done, closed, fixed, resolved',
    icon: ISSUE_CLOSED_PATH,
    color: STATE_COLOR.closed
  },
  not_planned: {
    title: 'Close as not planned',
    desc: "Won't fix, can't repro, stale",
    icon: ISSUE_SKIPPED_PATH,
    color: STATE_COLOR.skipped
  },
  duplicate: {
    title: 'Close as duplicate',
    desc: 'Duplicate of another issue',
    icon: ISSUE_SKIPPED_PATH,
    color: STATE_COLOR.skipped
  }
}

// Compact menu: narrow, small type, tight rows. Inline so the app's CSS build cannot drop any of it.
const MENU_WIDTH = '15rem'

function MenuRow({ reason, arrow, disabled, note, onClick }) {
  const r = CLOSE_REASONS[reason]
  return jsxs('button', {
    type: 'button',
    disabled,
    onClick,
    title: note,
    // A disabled row is inert: no hover highlight and a plain arrow cursor (inline so the app's button styles cannot override it).
    className: cn('flex w-full text-left', !disabled && 'hover:bg-(--ui-control-hover-background)', r.desc ? 'items-start' : 'items-center', disabled && 'opacity-60'),
    style: { gap: '0.5rem', padding: '0.3125rem 0.625rem', cursor: disabled ? 'default' : 'pointer' },
    children: [
      jsx(Icon, { path: r.icon, size: 14, className: r.desc ? 'mt-0.5' : undefined, color: r.color }),
      jsxs('span', {
        className: 'min-w-0 flex-1',
        children: [
          jsx('span', { className: 'block font-semibold', style: { fontSize: '0.75rem', lineHeight: '1rem', color: r.titleColor }, children: r.title }),
          r.desc
            ? jsx('span', { className: 'block text-(--ui-text-tertiary)', style: { fontSize: '0.6875rem', lineHeight: '0.9375rem' }, children: r.desc })
            : null
        ]
      }),
      arrow ? jsx(Icon, { path: ARROW_RIGHT_PATH, size: 12, className: 'mt-0.5 text-(--ui-text-tertiary)' }) : null
    ]
  })
}

/** Second pane of the popover: choose which issue this duplicates, then close immediately. */
function DuplicatePicker({ repo, issue, busy, onBack, onPick }) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let dead = false
    setLoading(true)
    setError(null)
    const t = setTimeout(
      () => {
        findDuplicateCandidates(repo, q, issue.number).then(
          r => {
            if (dead) return
            setItems(r)
            setLoading(false)
          },
          e => {
            if (dead) return
            setItems([])
            setError(e.message || String(e))
            setLoading(false)
          }
        )
      },
      q.trim() ? 300 : 0
    )
    return () => {
      dead = true
      clearTimeout(t)
    }
  }, [repo, q, issue.number])

  return jsxs('div', {
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2',
        children: [
          jsx('button', {
            type: 'button',
            'aria-label': 'Back',
            onClick: onBack,
            className: 'rounded p-1 text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
            children: jsx(Icon, { path: ARROW_LEFT_PATH })
          }),
          jsx('div', { className: 'font-semibold', style: { fontSize: '0.75rem' }, children: 'Close #' + issue.number + ' as duplicate of…' })
        ]
      }),
      jsx('div', {
        className: 'border-b border-(--ui-stroke-secondary) p-2',
        children: jsx(Input, {
          autoFocus: true,
          value: q,
          placeholder: 'Search issues, or type a number (e.g. 12)',
          autoComplete: 'off',
          spellCheck: false,
          onChange: e => setQ(e.target.value)
        })
      }),
      jsxs('div', {
        className: 'max-h-64 overflow-y-auto',
        children: [
          error ? jsx('div', { className: 'px-3 py-2 text-xs text-(--ui-red)', children: error }) : null,
          !error && !loading && items.length === 0
            ? jsx('div', { className: 'px-3 py-4 text-center text-xs text-(--ui-text-tertiary)', children: 'No matching issues.' })
            : null,
          loading && items.length === 0 ? jsx('div', { className: 'px-3 py-4 text-center text-xs text-(--ui-text-tertiary)', children: 'Searching…' }) : null,
          items.map(i =>
            jsxs('button', {
              key: i.number,
              type: 'button',
              disabled: busy,
              onClick: () => onPick(i),
              className: cn('flex w-full items-start gap-2.5 px-3 py-2 text-left', !busy && 'hover:bg-(--ui-control-hover-background)', busy && 'opacity-60'),
              style: { cursor: busy ? 'default' : 'pointer' },
              children: [
                jsx(IssueIcon, { issue: i }),
                jsxs('span', {
                  className: 'min-w-0 flex-1',
                  children: [
                    jsx('span', { className: 'block truncate', style: { fontSize: '0.75rem' }, children: i.title }),
                    jsx('span', { className: 'block text-xs text-(--ui-text-quaternary)', children: '#' + i.number })
                  ]
                })
              ]
            })
          )
        ]
      }),
      busy ? jsx('div', { className: 'border-t border-(--ui-stroke-secondary) px-3 py-2 text-xs text-(--ui-text-tertiary)', children: 'Closing…' }) : null
    ]
  })
}

/** Ellipsis -> the GitHub-style dialog. Open issue: close as completed / not planned / duplicate.
 *  Closed issue: Reopen issue / Close as not planned / Close as duplicate (re-close with another reason). */
/** Confirmation pane of the ⋯ menu's Delete row. Counts what lives below the issue first, then deletes it and everything below it
 *  (never its parent or siblings). With sub-issues the issue number must be typed to enable the button. */
function DeletePane({ repo, issue, onBack, onBusy, onGone, onDone }) {
  const [below, setBelow] = useState(null)
  const [error, setError] = useState(null)
  const [typed, setTyped] = useState('')
  const [progress, setProgress] = useState(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    let dead = false
    collectDescendants(repo, issue).then(
      r => !dead && setBelow(r),
      e => !dead && setError(e.message || String(e))
    )
    return () => {
      dead = true
    }
  }, [])

  const k = below ? below.length : 0
  const matches = k === 0 || typed.trim().replace(/^#/, '') === String(issue.number)

  const run = async () => {
    if (!below || working || !matches) return
    setWorking(true)
    onBusy(true)
    setError(null)
    try {
      const gone = await deleteIssueTree(issue, below, (done, total) => setProgress({ done, total }))
      haptic('tap')
      host.notify({ kind: 'success', message: 'Deleted #' + issue.number + (k ? ' and ' + k + ' sub-issue' + (k === 1 ? '' : 's') : '') })
      onGone(gone)
      onDone()
    } catch (e) {
      if (e.deleted && e.deleted.length) {
        onGone(e.deleted)
        setBelow(prev => (prev || []).filter(x => !e.deleted.includes(x.number)))
      }
      setError(e.message || String(e))
      setWorking(false)
      setProgress(null)
      onBusy(false)
    }
  }

  const small = { fontSize: '0.75rem', lineHeight: '1rem' }
  return jsxs('div', {
    // boxSizing/minWidth: nothing in the pane may be wider than the menu it sits in.
    style: { padding: '0.625rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', boxSizing: 'border-box', minWidth: 0 },
    children: [
      jsx('div', { className: 'font-semibold', style: { ...small, color: DANGER_COLOR }, children: 'Delete #' + issue.number + ' permanently?' }),
      below === null && !error
        ? jsx('div', { className: 'text-(--ui-text-tertiary)', style: small, children: 'Counting its sub-issues…' })
        : below !== null
          ? jsx('div', {
              className: 'text-(--ui-text-secondary)',
              style: small,
              children:
                k === 0
                  ? 'This deletes the issue for good. It cannot be undone.'
                  : 'This deletes the issue AND its ' + k + ' sub-issue' + (k === 1 ? '' : 's') + ' (all levels) for good, comments and history too. It cannot be undone.'
            })
          : null,
      jsx('div', { className: 'text-(--ui-text-quaternary)', style: { fontSize: '0.6875rem', lineHeight: '0.9375rem' }, children: 'Only this issue and what is below it. Its parent and sibling issues are not touched.' }),
      below !== null && k > 0
        ? jsx(Input, {
            // Focused as soon as it appears, so the number can be typed straight away.
            autoFocus: true,
            value: typed,
            disabled: working,
            placeholder: 'Type ' + issue.number + ' to confirm',
            'aria-label': 'Type the issue number to confirm the delete',
            onChange: e => setTyped(e.target.value),
            onKeyDown: e => e.key === 'Enter' && void run()
          })
        : null,
      error ? jsx('div', { role: 'alert', className: 'whitespace-pre-wrap text-(--ui-red)', style: small, children: error }) : null,
      jsxs('div', {
        // Wraps: "Delete issue and 12 sub-issues" + Back do not fit side by side in the narrow menu, so Back drops to the next line
        // instead of poking out past the right edge.
        className: 'flex items-center gap-2',
        style: { flexWrap: 'wrap', minWidth: 0 },
        children: [
          jsx(Button, {
            type: 'button',
            size: 'sm',
            variant: 'destructive',
            // The label may wrap onto two lines rather than be wider than the menu.
            style: { maxWidth: '100%', whiteSpace: 'normal', textAlign: 'center' },
            disabled: below === null || working || !matches,
            onClick: () => void run(),
            children: working
              ? 'Deleting' + (progress ? ' ' + progress.done + ' of ' + progress.total : '') + '…'
              : k > 0
                ? 'Delete issue and ' + k + ' sub-issue' + (k === 1 ? '' : 's')
                : 'Delete issue'
          }),
          jsx(Button, { type: 'button', size: 'sm', variant: 'ghost', disabled: working, onClick: onBack, children: 'Back' })
        ]
      })
    ]
  })
}

/** The pinned issues, shared with every ⋯ menu below the main view: which numbers are pinned, whether all 3 slots are used, and how to pin and
 *  reload. Null outside the main view. */
const PinsContext = createContext(null)

/** `variant` picks the row set: 'open' = Close as completed / not planned / duplicate, 'closed' = Reopen / not planned / duplicate.
 *  It defaults to the issue's own state; sub-issue rows pass their PARENT's list instead. */
function CloseMenu({ repo, issue, variant, compact, onClosed, onUpdated, onError, onEdit, editDisabled, onDeleted }) {
  const pins = useContext(PinsContext)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState('menu')
  const [busy, setBusy] = useState(false)
  const isClosed = (variant || issue.state) === 'closed'
  const rows = isClosed ? ['reopen', 'not_planned', 'duplicate'] : ['completed', 'not_planned', 'duplicate']

  const act = async (r, dupOf) => {
    setBusy(true)
    onError(null)
    try {
      if (r === 'reopen') {
        await reopenIssue(repo, issue.number)
        haptic('tap')
        host.notify({ kind: 'success', message: 'Reopened #' + issue.number })
        noteChange({ ...issue, state: 'open', state_reason: 'reopened', closed_at: null })
        if (pins) pins.reload() // a pinned card shows the issue's state
        setOpen(false)
        setBusy(false) // a list row unmounts here, but a sub-issue row inside a parent panel stays and must be usable again
        onClosed(issue.number, { state: 'open', state_reason: 'reopened', closed_at: null }) // it leaves the Closed list
        return
      }
      await closeIssue(repo, issue, r, dupOf)
      haptic('tap')
      host.notify({
        kind: 'success',
        message: 'Closed #' + issue.number + (r === 'duplicate' ? ' as a duplicate of #' + dupOf.number : r === 'not_planned' ? ' as not planned' : r === 'completed' && isClosed ? ' as completed' : '')
      })
      setOpen(false)
      noteChange({ ...issue, state: 'closed', state_reason: r, closed_at: new Date().toISOString() })
      if (pins) pins.reload()
      if (isClosed) {
        // The row STAYS in the Closed list with a new reason, so the menu must become usable again.
        setBusy(false)
        onUpdated({ state: 'closed', state_reason: r })
      } else {
        setBusy(false)
        onClosed(issue.number, { state: 'closed', state_reason: r, closed_at: new Date().toISOString() })
      }
    } catch (e) {
      onError(e.message || String(e))
      setBusy(false)
      setOpen(false)
    }
  }

  const divider = k => jsx('div', { key: 'd' + k, className: 'mx-2 border-t border-(--ui-stroke-secondary)' })
  const items = []
  // Top row: edit the description and labels (only where the row supports it). Disabled while the edit form is on screen.
  if (onEdit) {
    items.push(
      jsx(MenuRow, {
        key: 'edit',
        reason: 'edit',
        disabled: busy || editDisabled,
        note: editDisabled ? 'Already editing' : undefined,
        onClick: () => {
          setOpen(false)
          onEdit()
        }
      })
    )
    // "Pin issue" right under Edit. Disabled (with the reason as a tooltip) when this issue is already pinned or all 3 pin slots are used.
    if (pins) {
      const already = pins.isPinned(issue.number)
      const full = pins.count >= MAX_PINS
      items.push(
        jsx(MenuRow, {
          key: 'pin',
          reason: 'pin',
          disabled: busy || already || full,
          note: already ? 'Already pinned' : full ? 'Un-pin one of the ' + MAX_PINS + ' pinned issues first' : undefined,
          onClick: () => {
            setOpen(false)
            pins.pin(issue)
          }
        })
      )
    }
    items.push(divider('e'))
  }
  rows.forEach((r, i) => {
    if (i) items.push(divider(i))
    const already = issue.state === 'closed' && r === 'not_planned' && issue.state_reason === 'not_planned'
    items.push(
      jsx(MenuRow, {
        key: r,
        reason: r,
        arrow: r === 'duplicate',
        disabled: busy || already,
        note: already ? 'Already closed as not planned' : undefined,
        onClick: () => (r === 'duplicate' ? setView('duplicate') : void act(r))
      })
    )
  })
  // Last row, in red: permanently delete this issue and everything below it (confirmation pane first).
  if (onDeleted) {
    items.push(divider('x'))
    items.push(jsx(MenuRow, { key: 'delete', reason: 'delete', disabled: busy, onClick: () => setView('delete') }))
  }

  return jsxs(Popover, {
    open,
    onOpenChange: o => {
      if (busy) return
      setOpen(o)
      if (o) setView('menu')
    },
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsx('button', {
          type: 'button',
          disabled: busy,
          title: isClosed ? 'Reopen or change how it was closed…' : 'Close issue…',
          'aria-label': isClosed ? 'Reopen issue…' : 'Close issue…',
          // Radius is inline on purpose: it is the rollover's shape, and an arbitrary/unused class could be dropped.
          style: compact ? { borderRadius: '0.5rem', width: '1.5rem', height: '1.5rem' } : { borderRadius: '0.5rem', width: '2rem', height: '2rem' },
          className:
            'inline-flex shrink-0 items-center justify-center text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground disabled:opacity-60',
          children: jsx(Icon, { path: KEBAB_PATH, size: compact ? 14 : 16 })
        })
      }),
      jsx(PopoverContent, {
        variant: 'menu',
        align: 'end',
        className: 'p-0',
        style: { width: MENU_WIDTH },
        children:
          view === 'menu'
            ? jsxs('div', {
                children: [
                  ...items,
                  busy ? jsx('div', { className: 'border-t border-(--ui-stroke-secondary) px-2.5 py-1.5 text-xs text-(--ui-text-tertiary)', children: 'Working…' }) : null
                ]
              })
            : view === 'delete'
              ? jsx(DeletePane, {
                  repo,
                  issue,
                  onBack: () => setView('menu'),
                  onBusy: setBusy,
                  // Called with the numbers that no longer exist — also after a PARTIAL failure (the pane stays open to show the error).
                  onGone: nums => onDeleted(nums),
                  onDone: () => {
                    setBusy(false)
                    setOpen(false)
                  }
                })
              : jsx(DuplicatePicker, {
                  repo,
                  issue,
                  busy,
                  onBack: () => setView('menu'),
                  onPick: dup => void act('duplicate', dup)
                })
      })
    ]
  })
}

function CreateSubIssueForm({ repo, parent, labels, onCreated, onCancel }) {
  const [v, setV] = useState({ title: '', body: '', labels: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    if (!v.title.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const sub = await createSubIssue(repo, parent.number, { title: v.title, body: v.body, labels: v.labels })
      haptic('tap')
      host.notify({ kind: 'success', message: 'Created sub-issue #' + sub.number + ' under #' + parent.number })
      onCreated(sub)
    } catch (e) {
      if (e.created) {
        // The issue exists but is unlinked; clear the form so a retry can't create a duplicate.
        setV({ title: '', body: '', labels: [] })
      }
      setError(e.message || String(e))
      setBusy(false)
    }
  }

  return jsx(IssueForm, {
    heading: 'New sub-issue of #' + parent.number,
    autoFocus: true,
    title: v.title,
    body: v.body,
    picked: v.labels,
    options: labels,
    onChange: patch => setV(prev => ({ ...prev, ...patch })),
    busy,
    canSubmit: !!v.title.trim(),
    submitText: 'Create sub-issue',
    busyText: 'Creating…',
    onSubmit: () => void submit(),
    onCancel,
    error
  })
}

// ---- description renderer. Colors come from theme variables; sizes/indents are inline styles for
// the same reason as below (arbitrary classes may be dropped).
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
// Description + sub-issue text is one step below the 0.875rem (text-sm) used for issue titles.
const DETAIL_FONT = '0.8125rem'

function Inline({ nodes }) {
  return nodes.map((n, i) => {
    if (n.t === 'text') return n.text
    if (n.t === 'code') {
      return jsx('code', {
        key: i,
        style: { fontFamily: MONO, fontSize: '0.85em', padding: '0.1em 0.35em', borderRadius: '0.3em', background: 'var(--ui-inline-code-background)', color: 'var(--ui-inline-code-foreground)' },
        children: n.text
      })
    }
    if (n.t === 'b') return jsx('strong', { key: i, children: jsx(Inline, { nodes: n.children }) })
    if (n.t === 'i') return jsx('em', { key: i, children: jsx(Inline, { nodes: n.children }) })
    return jsx('button', {
      key: i,
      type: 'button',
      title: n.href,
      onClick: () => CTX.os.openExternal(n.href),
      style: { color: 'var(--ui-accent)', textDecoration: 'underline', textAlign: 'left', cursor: 'pointer' },
      children: n.text
    })
  })
}

function Markdown({ source }) {
  const blocks = parseMarkdown(source)
  const gap = { marginTop: '0.5rem' }
  return jsx('div', {
    className: 'text-(--ui-text-secondary)',
    style: { fontSize: DETAIL_FONT, lineHeight: 1.5, overflowWrap: 'anywhere' },
    children: blocks.map((b, i) => {
      const first = i === 0 ? {} : gap
      if (b.t === 'h') {
        const size = b.level === 1 ? '1.05rem' : b.level === 2 ? '0.95rem' : '0.85rem'
        return jsx('div', { key: i, className: 'font-semibold text-foreground', style: { ...first, fontSize: size }, children: jsx(Inline, { nodes: b.inline }) })
      }
      if (b.t === 'p') return jsx('p', { key: i, className: 'whitespace-pre-wrap', style: first, children: jsx(Inline, { nodes: b.inline }) })
      if (b.t === 'hr') return jsx('hr', { key: i, style: { ...gap, border: 0, borderTop: '1px solid var(--ui-stroke-secondary)' } })
      if (b.t === 'code') {
        return jsx('pre', {
          key: i,
          style: { ...first, fontFamily: MONO, fontSize: '0.72rem', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', overflowX: 'auto', background: 'var(--ui-inline-code-background)', color: 'var(--ui-inline-code-foreground)' },
          children: b.text
        })
      }
      if (b.t === 'quote') {
        return jsx('div', {
          key: i,
          className: 'text-(--ui-text-tertiary)',
          style: { ...first, borderLeft: '3px solid var(--ui-stroke-secondary)', paddingLeft: '0.75rem' },
          children: jsx(Inline, { nodes: parseInline(b.lines.join(' ')) })
        })
      }
      // list
      let n = 0
      return jsx('div', {
        key: i,
        style: first,
        children: b.items.map((it, j) => {
          n = it.depth === 0 ? n + 1 : n
          const mark = it.checked !== undefined ? (it.checked ? '☑' : '☐') : b.ordered ? n + '.' : '•'
          return jsxs('div', {
            key: j,
            className: 'flex items-start gap-2',
            style: { paddingLeft: it.depth * 1.25 + 'rem', marginTop: j ? '0.125rem' : 0 },
            children: [
              jsx('span', { 'aria-hidden': true, className: 'shrink-0 text-(--ui-text-tertiary)', style: { width: '1.1rem', textAlign: 'center' }, children: mark }),
              jsx('span', { className: 'min-w-0', style: { overflowWrap: 'anywhere' }, children: jsx(Inline, { nodes: it.inline }) })
            ]
          })
        })
      })
    })
  })
}

function IssueDescription({ repo, issue, body, edit, setEdit, onSaved, onTitleSaved, repoLabels, onLabelsSaved }) {
  // Editing is STARTED from the "Edit" row of the ⋯ menu (see IssueRow.beginEdit); this component renders the rendered description, or —
  // once `edit` is set — the same form that adds an issue, filled in with this issue's current title, description and labels.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [conflict, setConflict] = useState(null)
  const has = !!String(body || '').trim()

  const ready = !!edit && edit.phase === 'edit'
  const dirtyTitle = ready && edit.title.trim() !== edit.baseTitle.trim()
  const dirtyBody = ready && normBody(edit.text) !== normBody(edit.base)
  const dirtyLabels = ready && !sameLabels(edit.labels, edit.baseLabels)

  const save = async force => {
    if (busy || !ready || (!dirtyTitle && !dirtyBody && !dirtyLabels)) return
    if (!edit.title.trim()) return setError('The title cannot be empty.')
    setBusy(true)
    setError(null)
    try {
      if (!force) {
        // Someone (or something) may have changed it since the editor opened — don't overwrite blindly.
        // Only the fields being saved can conflict: a field we are not sending cannot be clobbered.
        const latest = await fetchIssueDetail(repo, issue.number)
        const titleHit = dirtyTitle && latest.title.trim() !== edit.baseTitle.trim()
        const bodyHit = dirtyBody && normBody(latest.body) !== normBody(edit.base)
        const labelHit = dirtyLabels && !sameLabels(latest.labels, edit.baseLabels)
        if (titleHit || bodyHit || labelHit) {
          setConflict({ detail: latest, titleHit, bodyHit, labelHit })
          setBusy(false)
          return
        }
      }
      const fields = {}
      if (dirtyTitle) fields.title = edit.title
      if (dirtyBody) fields.body = edit.text
      if (dirtyLabels) fields.labels = edit.labels
      const updated = await updateIssueFields(repo, issue.number, fields)
      haptic('tap')
      const parts = [dirtyTitle ? 'title' : null, dirtyBody ? 'description' : null, dirtyLabels ? 'labels' : null].filter(Boolean)
      host.notify({ kind: 'success', message: 'Updated #' + issue.number + ' (' + parts.join(', ') + ')' })
      if (dirtyTitle) onTitleSaved(updated.title)
      if (dirtyBody) onSaved(updated.body)
      if (dirtyLabels) onLabelsSaved(updated.labels, true)
      setConflict(null)
      setEdit(null)
    } catch (e) {
      setError(e.message || String(e))
    }
    setBusy(false)
  }

  if (edit && edit.phase === 'loading') {
    return jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: 'Loading the latest title, description and labels…' })
  }

  if (edit) {
    // Offer the repo's real labels plus any the issue already has (so none can be dropped by accident).
    const known = new Map()
    for (const l of repoLabels || []) known.set(l.name, l)
    for (const l of issue.labels) if (!known.has(l.name)) known.set(l.name, l)
    const what = conflict ? [conflict.titleHit ? 'title' : null, conflict.bodyHit ? 'description' : null, conflict.labelHit ? 'labels' : null].filter(Boolean).join(', ') : ''
    const notice =
      conflict !== null
        ? jsxs('div', {
            className: 'space-y-2 rounded-md p-2 text-xs',
            // Inline: an arbitrary border-colour class the app never uses would be dropped by its CSS build.
            style: { border: '1px solid var(--ui-orange)' },
            children: [
              jsx('div', { className: 'text-(--ui-orange)', children: 'The ' + what + ' of this issue changed on GitHub after you started editing. Saving now would overwrite that change.' }),
              jsxs('div', {
                className: 'flex flex-wrap gap-2',
                children: [
                  jsx(Button, { type: 'button', size: 'sm', disabled: busy, onClick: () => void save(true), children: 'Overwrite with my version' }),
                  jsx(Button, {
                    type: 'button',
                    size: 'sm',
                    variant: 'secondary',
                    disabled: busy,
                    onClick: () => {
                      // Take GitHub's current values for everything; the user's unsaved edits are dropped.
                      const d = conflict.detail
                      setEdit(editFromDetail(d))
                      onTitleSaved(d.title)
                      onSaved(d.body)
                      onLabelsSaved(d.labelObjs, false)
                      setConflict(null)
                    },
                    children: 'Discard my edit, load the latest'
                  }),
                  jsx(Button, { type: 'button', size: 'sm', variant: 'ghost', disabled: busy, onClick: () => setConflict(null), children: 'Keep editing' })
                ]
              })
            ]
          })
        : null
    return jsx(IssueForm, {
      autoFocus: true,
      title: edit.title,
      body: edit.text,
      picked: edit.labels,
      options: [...known.values()],
      onChange: patch => setEdit(prev => ({ ...prev, ...('title' in patch ? { title: patch.title } : {}), ...('body' in patch ? { text: patch.body } : {}), ...('labels' in patch ? { labels: patch.labels } : {}) })),
      busy,
      canSubmit: (dirtyTitle || dirtyBody || dirtyLabels) && !!edit.title.trim() && conflict === null,
      submitText: 'Update',
      busyText: 'Updating…',
      onSubmit: () => void save(false),
      onCancel: () => {
        setEdit(null)
        setConflict(null)
        setError(null)
      },
      error,
      notice
    })
  }

  return has ? jsx(Markdown, { source: body }) : jsx('div', { className: 'text-xs italic text-(--ui-text-quaternary)', children: 'No description provided.' })
}

// Subtle tint for an expanded parent issue, derived from the SAME theme highlight as the New issue button
// (follows every theme; 4% so it never competes with content).
// Roll state of a list row: clearly fainter than both a sub-issue row's (5%) and the expanded tint (4%), so a hovered row never looks like an
// open one; never applied to a row that is already open.
const ROW_HOVER_BG = 'color-mix(in srgb, var(--foreground, currentColor) 1.5%, transparent)'
const EXPANDED_ROW_BG = 'color-mix(in srgb, ' + ACCENT_SOLID + ' 4%, transparent)'

// Indents are inline styles on purpose: a disk plugin is not run through the app's Tailwind build,
// so an arbitrary class (ml-[3.25rem]) the app itself never uses is silently dropped.
// Two separate rounded containers, stacked with a gap: the parent's DESCRIPTION and the SUB-ISSUES.
// Their OUTER left edge lines up with the issue TITLE text: the 16px issue icon + the header's gap-3 (0.75rem) = 1.75rem.
// Content sits inside the 1px border + 0.75rem padding; sub-issue rows are indented one step further.
const TITLE_INDENT = '1.75rem'
const PANEL_STYLE = {
  marginTop: '0.75rem',
  marginLeft: TITLE_INDENT,
  padding: '0.75rem',
  border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: '0.5rem'
}
// The description box differs from the neutral sub-issues box by its LINE colour only (theme accent,
// like GitHub's blue-edged first comment) — no fill.
const DESC_PANEL_STYLE = {
  ...PANEL_STYLE,
  border: '1px solid color-mix(in srgb, var(--ui-accent) 45%, transparent)'
}
const SUB_ROW_INDENT = '1.5rem'
// The expanded details of a sub-issue line up with its title text (16px state icon + the row's 0.625rem gap).
const SUB_DETAIL_INDENT = '1.625rem'
// ~5% of the theme foreground: visible as a faint band on any theme, never competes with the text.
// The right margin shared by the title row, search box, Open/Closed/Labels bar and the issue rows.
const RIGHT_MARGIN = '1rem'
// The left margin of the whole page: the gap between the Desktop's left nav and everything we draw. The pane host adds none of its own, so
// without this the page sits against the nav. 2.25rem (36px) matches the gap the chat pane keeps beside the nav (its message boxes start 36px in).
const LEFT_MARGIN = '2.25rem'
// In the docked right-side panel the page is not beside the Desktop nav, so it drops the 36px nav-clearance margin for a slim one.
const DOCKED_MARGIN = '0.75rem'
const DockContext = createContext(false)
const useLeftMargin = () => (useContext(DockContext) ? DOCKED_MARGIN : LEFT_MARGIN)
const SUB_ROW_HOVER_BG = 'color-mix(in srgb, var(--foreground, currentColor) 5%, transparent)'

/** One sub-issue: state icon, title, link icon … trash on the far right (two-step remove). */
function SubIssueRow({ repo, parent, sub, last, index, count, dnd, open, onOpen, labels, defaultCollapsed, onStale, onSubChanged, onSubDeleted }) {
  const [hover, setHover] = useState(false)
  const [gripFocus, setGripFocus] = useState(false)
  const [error, setError] = useState(null)
  // Same model as a parent row: the description lives here so an unsaved draft survives collapsing the row.
  const [body, setBody] = useState(sub.body)
  const [edit, setEdit] = useState(null)
  const formViewable = !!edit && open

  // A sub-issue can have sub-issues of its own: when this one is open it shows a Sub-issues section exactly like a parent issue does
  // (same component, so it nests to any depth). Loaded when the row is first opened.
  const [subs, setSubs] = useState(null)
  const [subError, setSubError] = useState(null)
  const loadSubs = useCallback(() => {
    setSubError(null)
    listSubIssues(repo, sub.number).then(setSubs, e => setSubError(e.message || String(e)))
  }, [repo, sub.number])
  useEffect(() => {
    if (open && subs === null) loadSubs()
  }, [open])
  const total = subs ? subs.length : sub.sub_total
  const done = subs ? subs.filter(x => x.state === 'closed').length : sub.sub_done

  const toggle = () => {
    // Selecting text inside the row is not a click-to-toggle.
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
    if (selection && !selection.isCollapsed && String(selection).trim()) return
    onOpen(open ? null : sub.number)
  }

  // Started from the ⋯ menu's Edit row: expand this sub-issue (collapsing any other), then load GitHub's CURRENT description and
  // labels into the editor. A draft kept while collapsed => just re-show it.
  const beginEdit = async () => {
    if (!open) onOpen(sub.number)
    if (edit) return
    setError(null)
    setEdit(EDIT_LOADING)
    try {
      const latest = await fetchIssueDetail(repo, sub.number)
      if (normBody(latest.body) !== normBody(body)) setBody(latest.body)
      if (latest.title !== sub.title) onSubChanged(sub, { title: latest.title })
      if (!sameLabels(latest.labels, sub.labels.map(l => l.name))) onSubChanged(sub, { labels: latest.labelObjs })
      setEdit(editFromDetail(latest))
    } catch (e) {
      setEdit(null)
      setError(e.message || String(e))
    }
  }
  const when = sub.state === 'closed' ? 'closed ' + ago(sub.closed_at) : 'opened ' + ago(sub.created_at)

  const dragging = dnd.dragId === sub.number
  const showLine = pos => dnd.dragId !== null && dnd.slot === pos && dnd.slot !== dnd.fromIndex && dnd.slot !== dnd.fromIndex + 1
  const line = top => jsx('div', {
    'aria-hidden': true,
    style: { position: 'absolute', left: 0, right: 0, [top ? 'top' : 'bottom']: '-1px', height: '2px', borderRadius: '1px', background: 'var(--ui-accent)', pointerEvents: 'none' }
  })

  return jsxs('div', {
    // Dividers sit BETWEEN sub-issues; the last row has none.
    className: cn('py-2', !last && 'border-b border-(--ui-stroke-secondary)'),
    'data-sub-row': sub.number,
    // isolation: the highlight sits at z-index -1 INSIDE this row, i.e. behind its content but above anything beneath it.
    style: { marginLeft: SUB_ROW_INDENT, position: 'relative', isolation: 'isolate', opacity: dragging ? 0.45 : 1 },
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    // Browsers send no mouseleave while a drag is in progress, so hover can be left stuck on. After a drag the
    // next real pointer movement over the row is what turns it back on.
    onMouseMove: () => {
      if (!hover) setHover(true)
    },
    onDragOver: dnd.dragId === null ? undefined : e => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      const r = e.currentTarget.getBoundingClientRect()
      dnd.over(e.clientY < r.top + r.height / 2 ? index : index + 1)
    },
    onDrop: dnd.dragId === null ? undefined : e => {
      e.preventDefault()
      dnd.drop()
    },
    children: [
      // Very subtle whole-row roll state: a barely-there foreground tint that extends a little past the text
      // (so it does not hug the content) without moving the content or the divider line.
      hover && dnd.dragId === null
        ? jsx('div', { 'aria-hidden': true, 'data-sub-hover': true, style: { position: 'absolute', top: 0, bottom: 0, left: '-0.375rem', right: '-0.375rem', zIndex: -1, borderRadius: '0.375rem', background: SUB_ROW_HOVER_BG, pointerEvents: 'none' } })
        : null,
      showLine(index) ? line(true) : null,
      index === count - 1 && showLine(count) ? line(false) : null,
      jsxs('div', {
        // The WHOLE row header toggles it open/closed in place (no chevron: the pointer cursor and the row highlight signal it).
        // Only one sub-issue is open at a time. The grip, link icon and ⋯ menu are fenced off and never toggle it.
        className: 'flex cursor-pointer items-center gap-2.5',
        style: { position: 'relative' },
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        'aria-label': (open ? 'Hide' : 'Show') + ' description of #' + sub.number,
        onClick: toggle,
        onKeyDown: e => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            toggle()
          }
        },
        children: [
          // Drag handle: only shown on hover/focus, only for lists with something to reorder. It is the ONLY
          // drag source — the rest of the row (title, links) is not draggable.
          // While a move is in flight the grip stays mounted (removing a drag source mid-drag can swallow
          // `dragend`) but is disabled, so moves cannot overlap.
          count > 1
            ? jsx('button', {
                type: 'button',
                draggable: dnd.canDrag,
                disabled: !dnd.canDrag,
                title: 'Drag to reorder (or focus and press ↑ / ↓)',
                'aria-label': 'Reorder #' + sub.number + ' — drag, or press up/down arrow',
                className: 'inline-flex items-center rounded text-(--ui-text-tertiary) hover:text-foreground',
                style: {
                  position: 'absolute',
                  left: '-1.3rem',
                  cursor: dnd.canDrag ? 'grab' : 'default',
                  padding: '0.1rem',
                  opacity: hover || gripFocus || dragging ? 1 : 0,
                  transition: 'opacity 120ms'
                },
                onFocus: e => {
                  let keyboard = true
                  try {
                    keyboard = e.currentTarget.matches(':focus-visible')
                  } catch (err) {}
                  setGripFocus(keyboard)
                },
                onBlur: () => setGripFocus(false),
                onClick: e => e.stopPropagation(),
                onDragStart: e => {
                  if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', '#' + sub.number)
                    const rowEl = e.currentTarget.closest('[data-sub-row]')
                    if (rowEl && typeof e.dataTransfer.setDragImage === 'function') e.dataTransfer.setDragImage(rowEl, 8, 12)
                  }
                  dnd.start(sub)
                },
                onDragEnd: e => {
                  // Clear every "sticky" reveal: hover (no mouseleave arrives during a drag) and the focus the
                  // mouse press gave the button. The grip reappears on the next real hover or keyboard focus.
                  setHover(false)
                  setGripFocus(false)
                  if (e.currentTarget && typeof e.currentTarget.blur === 'function') e.currentTarget.blur()
                  dnd.end()
                },
                onKeyDown: e => {
                  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault()
                    dnd.move(sub, e.key === 'ArrowUp' ? -1 : 1)
                  }
                },
                children: jsx(Icon, { path: GRIP_PATH, size: 14 })
              })
            : null,
          // Same icon style as the parent row: open = the theme highlight (not fixed green); completed / not planned keep
          // their state colours.
          jsx(IssueIcon, { issue: sub, flat: true, accent: true }),
          jsxs('span', {
            className: 'min-w-0 truncate',
            style: { fontSize: DETAIL_FONT },
            title: sub.title,
            children: [sub.title, jsx('span', { className: 'ml-1.5 text-(--ui-text-quaternary)', children: '#' + sub.number })]
          }),
          jsx(IssueLinkButton, { issue: sub }),
          // Same as a parent row: the sub-issue count pill (only if it has sub-issues of its own), then the label pills — shown
          // whether the row is collapsed or expanded.
          total > 0 ? jsx(SubIssuePill, { done, total }) : null,
          sub.labels.map(l => jsx(LabelPill, { key: l.name, label: l })),
          // The same ⋯ menu as the list rows, with the row set of the list the PARENT belongs to (Open list: Close as ...,
          // Closed list: Reopen / ...), plus the top Edit row like the list rows have.
          jsx('div', {
            className: 'ml-auto shrink-0',
            style: { cursor: 'default' },
            onClick: e => e.stopPropagation(),
            children: jsx(CloseMenu, {
              repo,
              issue: sub,
              variant: parent.state,
              compact: true,
              onEdit: () => void beginEdit(),
              editDisabled: formViewable,
              // Deleted (with everything below it): the owner of this list drops it and tells the levels above.
              onDeleted: nums => onSubDeleted(nums),
              onError: setError,
              onClosed: (n, patch) => onSubChanged(sub, patch),
              onUpdated: patch => onSubChanged(sub, patch)
            })
          })
        ]
      }),
      // Expanded: the same information and editor as a parent issue, inside the row (aligned with the title text).
      open
        ? jsxs('div', {
            style: { ...DESC_PANEL_STYLE, marginTop: '0.5rem', marginLeft: SUB_DETAIL_INDENT },
            children: [
              jsx('div', {
                className: 'text-xs text-(--ui-text-tertiary)',
                children: repo + '#' + sub.number + ' · ' + sub.author + ' ' + when
              }),
              jsx('div', {
                style: { marginTop: '0.5rem' },
                children: jsx(IssueDescription, {
                  repo,
                  issue: sub,
                  body,
                  edit,
                  setEdit,
                  onSaved: setBody,
                  onTitleSaved: title => onSubChanged(sub, { title }),
                  repoLabels: labels,
                  onLabelsSaved: labelObjs => onSubChanged(sub, { labels: labelObjs })
                })
              })
            ]
          })
        : null,
      // Its own Sub-issues section (list, create, filter, collapse, per-sub-issue editing), below the description like a parent's.
      open
        ? jsx(SubIssueRows, {
            repo,
            parent: sub,
            subs,
            subError,
            canCreate: sub.state === 'open',
            labels,
            done,
            total,
            defaultCollapsed,
            indent: SUB_DETAIL_INDENT,
            onStale,
            onSubDeleted: nums => {
              setSubs(prev => (prev || []).filter(x => !nums.includes(x.number)))
              onSubDeleted(nums)
            },
            onSubChanged: (child, patch) => {
              setSubs(prev => (prev || []).map(x => (x.number === child.number ? { ...x, ...patch } : x)))
              onStale && onStale()
            },
            onReorder: next => setSubs(next),
            onResync: () => void listSubIssues(repo, sub.number).then(setSubs, () => {}),
            onRetry: loadSubs,
            onCreated: child => {
              if (subs === null) loadSubs()
              else setSubs(prev => prev.concat(child))
              onStale && onStale()
            }
          })
        : null,
      error ? jsx('div', { className: 'pt-1 text-xs text-(--ui-red)', children: error }) : null
    ]
  })
}

/** "Issues to include" menu for the sub-issue list: Open and closed / Open only. */
function SubFilterMenu({ mode, onChange }) {
  const [open, setOpen] = useState(false)
  const active = mode === 'open'
  const rows = [
    ['all', 'Open and closed'],
    ['open', 'Open only']
  ]
  return jsxs(Popover, {
    open,
    onOpenChange: setOpen,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsx('button', {
          type: 'button',
          title: active ? 'Filter sub-issues (open only)' : 'Filter sub-issues',
          'aria-label': 'Filter sub-issues',
          // 24px hit area with -4px vertical margins: it contributes 16px to the header row's height, so showing the filter never
          // makes the row taller (the "Sub-issues" label and chevron stay put). Inline so no class can drop it.
          style: { borderRadius: '0.5rem', width: '1.5rem', height: '1.5rem', marginTop: '-0.25rem', marginBottom: '-0.25rem' },
          // A bordered icon button, like GitHub's. Brighter icon while a filter is hiding something.
          className: cn(
            'inline-flex shrink-0 items-center justify-center border border-(--ui-stroke-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
            active ? 'text-foreground' : 'text-(--ui-text-tertiary)'
          ),
          children: jsx(Icon, { path: FILTER_PATH, size: 12 })
        })
      }),
      jsx(PopoverContent, {
        variant: 'menu',
        align: 'end',
        className: 'p-0',
        style: { width: '13rem' },
        children: jsxs('div', {
          role: 'menu',
          children: [
            jsx('div', { className: 'text-(--ui-text-tertiary)', style: { fontSize: '0.6875rem', padding: '0.4rem 0.625rem 0.2rem' }, children: 'Issues to include' }),
            rows.map(([id, label]) =>
              jsxs('button', {
                key: id,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': mode === id,
                onClick: () => {
                  onChange(id)
                  setOpen(false)
                },
                className: 'flex w-full items-center text-left hover:bg-(--ui-control-hover-background)',
                style: { gap: '0.5rem', padding: '0.3125rem 0.625rem', fontSize: '0.75rem', lineHeight: '1rem' },
                children: [
                  // Fixed slot so both labels line up whether or not they carry the check.
                  jsx('span', { className: 'inline-flex w-3.5 shrink-0 justify-center', children: mode === id ? jsx(Icon, { path: CHECK_PATH, size: 14 }) : null }),
                  label
                ]
              })
            )
          ]
        })
      })
    ]
  })
}

/** The Sub-issues section of an issue. `parent` may itself be a sub-issue (an expanded sub-issue row renders one for its own
 *  children, to any depth); `indent` is the section's left edge. */
function SubIssueRows({ repo, parent, subs, subError, canCreate, labels, done, total, defaultCollapsed, indent = TITLE_INDENT, onStale, onCreated, onSubChanged, onSubDeleted, onReorder, onResync, onRetry }) {
  const [creating, setCreating] = useState(false)
  // Starts collapsed or expanded per the Settings option ("Collapse sub-issues by default"); the chevron toggles it from there.
  const openKey = repo + '#' + parent.number
  const [collapsed, setCollapsedState] = useState(() => (SECTION_COLLAPSED.has(openKey) ? SECTION_COLLAPSED.get(openKey) : !!defaultCollapsed))
  const setCollapsed = fn =>
    setCollapsedState(c => {
      const next = typeof fn === 'function' ? fn(c) : fn
      SECTION_COLLAPSED.set(openKey, next)
      return next
    })
  const panelRef = useRef(null)
  const scrollWanted = useRef(false)
  // Only ONE sub-issue is open at a time (descriptions can be long); which one is remembered per parent for the session.
  const [openSub, setOpenSubState] = useState(() => (OPEN_SUB.has(openKey) ? OPEN_SUB.get(openKey) : null))
  const setOpenSub = n => {
    if (n === null) OPEN_SUB.delete(openKey)
    else OPEN_SUB.set(openKey, n)
    setOpenSubState(n)
  }
  const [dragId, setDragId] = useState(null)
  const [slot, setSlot] = useState(null)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState(null)
  const [mode, setModeState] = useState(() => (CTX && CTX.storage.get(STORE_SUBFILTER, 'all') === 'open' ? 'open' : 'all'))
  const note = 'py-2 text-xs text-(--ui-text-tertiary)'

  // The filter only exists (and only applies) with MORE THAN ONE sub-issue: a stored "open only" must never be able to
  // hide the only sub-issue with no control left to undo it.
  const canFilter = !!subs && subs.length > 1
  const shown = subs ? filterSubs(subs, canFilter ? mode : 'all') : null
  const hidden = subs && shown ? subs.length - shown.length : 0
  const setMode = m => {
    setModeState(m)
    if (CTX) CTX.storage.set(STORE_SUBFILTER, m)
  }
  const fromIndex = shown && dragId !== null ? shown.findIndex(x => x.number === dragId) : -1

  const commit = async (from, to) => {
    // Indices are positions in the list ON SCREEN; the move is anchored to a visible neighbour and applied to the full list.
    const plan = planMove(shown, from, to)
    if (!plan || moving) return
    const before = subs
    setMoving(true)
    setMoveError(null)
    onReorder(applyPos(subs, plan.moved, plan.pos)) // optimistic
    try {
      await reorderSubIssue(repo, parent.number, plan.moved, plan.pos)
      haptic('tap')
      // The order is stored on GitHub (the parent's sub-issue priority), so it persists across reloads and
      // devices. Re-read it so what is shown is exactly what is stored (quiet; keeps the local order on failure).
      onResync()
    } catch (e) {
      onReorder(before) // roll back
      setMoveError(e.message || String(e))
    }
    setMoving(false)
  }

  // After the USER expands the list, bring the pane into view if (part of) it is off-screen. block:'nearest' is a no-op when it is
  // already fully visible. If the sub-issues are still loading, wait for them so the final height is what gets scrolled to.
  useEffect(() => {
    if (!scrollWanted.current || collapsed) return
    if (subs === null && !subError) return
    scrollWanted.current = false
    const el = panelRef.current
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [collapsed, subs, subError])

  const dnd = {
    dragId,
    slot,
    fromIndex,
    canDrag: !moving,
    start: sub => {
      setMoveError(null)
      setDragId(sub.number)
    },
    end: () => {
      setDragId(null)
      setSlot(null)
    },
    over: s => setSlot(s),
    drop: () => {
      const from = fromIndex
      const s = slot
      setDragId(null)
      setSlot(null)
      if (from < 0 || s === null) return
      void commit(from, s > from ? s - 1 : s)
    },
    move: (sub, dir) => {
      const from = shown.findIndex(x => x.number === sub.number)
      void commit(from, from + dir)
    }
  }

  // The opener is the app's plain default (primary) button — exactly the fill, hover and active state of "New issue" (no inline styling). Only its
  // size is the compact one (sm). Once the form is open it is replaced by the form's own Create sub-issue button, which is the same button.
  const createButton = jsx(Button, {
    type: 'button',
    size: 'sm',
    onClick: () => setCreating(true),
    children: 'Create sub-issue'
  })

  // NO sub-issues: no section, no rounded container, no header — only the Create sub-issue button (and nothing at all for a
  // closed issue, which cannot get new sub-issues). Clicking the button swaps it for the form. This mode ignores the
  // "collapse by default" setting on purpose: there is nothing to collapse, and a collapsed form would be invisible.
  if (total === 0 && !subError) {
    if (!canCreate) return null
    if (!creating) return jsx('div', { style: { marginTop: '0.75rem', marginLeft: indent }, children: createButton })
    return jsx('div', {
      style: { ...PANEL_STYLE, marginLeft: indent },
      children: jsx(CreateSubIssueForm, {
        repo,
        parent,
        labels,
        onCancel: () => setCreating(false),
        onCreated: sub => {
          setCreating(false)
          onCreated(sub)
        }
      })
    })
  }

  return jsxs('div', {
    ref: panelRef,
    style: { ...PANEL_STYLE, marginLeft: indent },
    children: [
      jsxs('div', {
        // The WHOLE header row toggles the list (like an issue row). It is the only toggle control: focusable, Enter/Space,
        // aria-expanded. The filter menu sits in a fenced wrapper below, so using it never toggles the list.
        className: 'flex cursor-pointer items-center gap-2 text-xs font-semibold text-(--ui-text-secondary)',
        style: { paddingBottom: collapsed ? 0 : '0.25rem' },
        role: 'button',
        tabIndex: 0,
        'aria-expanded': !collapsed,
        'aria-label': (collapsed ? 'Expand' : 'Collapse') + ' sub-issues',
        title: (collapsed ? 'Expand' : 'Collapse') + ' sub-issues',
        onClick: () => {
          haptic('tap')
          if (collapsed) scrollWanted.current = true
          setCollapsed(c => !c)
        },
        onKeyDown: e => {
          // Only when the header itself has focus; keys on the filter menu belong to it.
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            if (collapsed) scrollWanted.current = true
            setCollapsed(c => !c)
          }
        },
        children: [
          jsxs('span', {
            className: 'inline-flex items-center gap-1.5',
            children: [jsx(Icon, { path: collapsed ? CHEVRON_RIGHT_PATH : CHEVRON_DOWN_PATH, size: 16, className: 'text-(--ui-text-tertiary)' }), 'Sub-issues']
          }),
          total > 0 ? jsx(SubIssueCountPill, { done, total }) : null,
          // Fence: clicks (and clicks bubbling out of the filter popover, which is a React child) never reach the header.
          canFilter && !collapsed
            ? jsx('div', { className: 'ml-auto', style: { cursor: 'default' }, onClick: e => e.stopPropagation(), children: jsx(SubFilterMenu, { mode, onChange: setMode }) })
            : null
        ]
      }),
      // Collapsed = hidden, not unmounted, so an in-progress "create sub-issue" draft survives.
      jsxs('div', {
        style: collapsed ? { display: 'none' } : undefined,
        children: [
          moveError ? jsx('div', { className: 'pb-1 text-xs text-(--ui-red)', style: { marginLeft: SUB_ROW_INDENT }, children: moveError }) : null,
          subs === null && !subError ? jsx('div', { className: note, style: { marginLeft: SUB_ROW_INDENT }, children: 'Loading sub-issues…' }) : null,
          subError
            ? jsxs('div', {
                className: 'flex items-center gap-2 py-2 text-xs text-(--ui-red)',
                style: { marginLeft: SUB_ROW_INDENT },
                children: [subError, jsx(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: onRetry, children: 'Retry' })]
              })
            : null,
          subs && subs.length === 0 && !creating ? jsx('div', { className: note, style: { marginLeft: SUB_ROW_INDENT }, children: 'No sub-issues yet.' }) : null,
          shown && shown.length === 0 && subs.length > 0 ? jsx('div', { className: note, style: { marginLeft: SUB_ROW_INDENT }, children: 'No open sub-issues.' }) : null,
          // Lines separate sub-issues from each other only (none after the last one).
          shown
            ? shown.map((sub, i) => jsx(SubIssueRow, { key: sub.number, repo, parent, sub, last: i === shown.length - 1, index: i, count: shown.length, dnd, open: openSub === sub.number, onOpen: setOpenSub, labels, defaultCollapsed, onStale, onSubChanged, onSubDeleted }))
            : null,
          hidden > 0
            ? jsxs('div', {
                className: 'flex items-center gap-2 text-xs text-(--ui-text-quaternary)',
                style: { marginLeft: SUB_ROW_INDENT, paddingTop: '0.5rem' },
                children: [
                  hidden + ' closed sub-issue' + (hidden === 1 ? '' : 's') + ' hidden',
                  jsx('button', { type: 'button', className: 'underline', onClick: () => setMode('all'), children: 'Show all' })
                ]
              })
            : null,
          canCreate && !creating
            ? jsx('div', {
                style: { paddingTop: '0.5rem' },
                children: createButton
              })
            : null,
          canCreate && creating
            ? jsx('div', {
                style: { paddingTop: '0.5rem' },
                children: jsx(CreateSubIssueForm, {
                  repo,
                  parent,
                  labels,
                  onCancel: () => setCreating(false),
                  onCreated: sub => {
                    setCreating(false)
                    onCreated(sub)
                  }
                })
              })
            : null
        ]
      })
    ]
  })
}

function IssueRow({ repo, issue, canClose, labels, last, collapseSubs, onClosed, onUpdated, onDeleted, onStale }) {
  const pinsCtx = useContext(PinsContext)
  const [error, setError] = useState(null)
  const rowKey = repo + '#' + issue.number
  const [hover, setHover] = useState(false)
  // Remembered across Open/Closed switches (the list is rebuilt when the tab changes).
  const [open, setOpenState] = useState(() => ROW_OPEN.has(rowKey))
  const setOpen = v => {
    if (v) ROW_OPEN.add(rowKey)
    else ROW_OPEN.delete(rowKey)
    setOpenState(v)
  }
  const [subs, setSubs] = useState(null)
  const [subError, setSubError] = useState(null)
  // Description lives here (not in IssueDescription) so an unsaved draft survives collapsing the row.
  const [body, setBody] = useState(issue.body)
  const [edit, setEdit] = useState(null)

  // The row's label pills come from the list payload, so a label edit is pushed up to the list. `changed`: it was OUR save
  // (versus just syncing to GitHub's latest), so any label-filtered counts need a re-read.
  const onLabelsSaved = (labelObjs, changed) => {
    if (onUpdated) onUpdated(issue.number, { labels: labelObjs })
    if (changed && onStale) onStale()
  }

  // True while the edit form is on screen (row expanded and an edit open). The menu's Edit row is disabled then.
  const formViewable = !!edit && open

  // Started from the top row of the ⋯ menu: expand the row (so the editor is visible), then load GitHub's CURRENT description and labels
  // into the editor (not the possibly stale list copy). A draft kept while collapsed => just re-show it.
  const beginEdit = async () => {
    if (!open) {
      setOpen(true)
      if (subs === null) loadSubs()
    }
    if (edit) return
    setError(null)
    setEdit(EDIT_LOADING)
    try {
      const latest = await fetchIssueDetail(repo, issue.number)
      if (normBody(latest.body) !== normBody(body)) setBody(latest.body)
      if (latest.title !== issue.title && onUpdated) onUpdated(issue.number, { title: latest.title })
      if (!sameLabels(latest.labels, issue.labels.map(l => l.name))) onLabelsSaved(latest.labelObjs, false)
      setEdit(editFromDetail(latest))
    } catch (e) {
      setEdit(null)
      setError(e.message || String(e))
    }
  }

  const loadSubs = useCallback(() => {
    setSubError(null)
    listSubIssues(repo, issue.number).then(setSubs, e => setSubError(e.message || String(e)))
  }, [repo, issue.number])

  // These issue numbers no longer exist (this issue and/or things below it): forget their display state, drop them from every list
  // level that shows them, and have the counts re-read.
  const gone = nums => {
    for (const n of nums) {
      const k = repo + '#' + n
      ROW_OPEN.delete(k)
      OPEN_SUB.delete(k)
      SECTION_COLLAPSED.delete(k)
    }
    setSubs(prev => (prev ? prev.filter(x => !nums.includes(x.number)) : prev))
    if (onDeleted) onDeleted(nums)
    onStale && onStale()
    if (pinsCtx) pinsCtx.reload() // GitHub drops the pin of a deleted issue
  }

  // Rebuilt already expanded (e.g. after switching lists): load its sub-issues right away.
  useEffect(() => {
    if (open && subs === null) loadSubs()
  }, [])

  const toggle = () => {
    // Selecting text inside the row is not a click-to-toggle.
    const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
    if (sel && !sel.isCollapsed && String(sel).trim()) return
    const next = !open
    setOpen(next)
    if (next && subs === null) loadSubs()
  }

  // Once loaded, the list is the source of truth for the pill; before that, use the list payload.
  const total = subs ? subs.length : issue.sub_total
  const done = subs ? subs.filter(x => x.state === 'closed').length : issue.sub_done
  const when = issue.state === 'closed' ? 'closed ' + ago(issue.closed_at) : 'opened ' + ago(issue.created_at)

  return jsxs('li', {
    // Dividers sit BETWEEN rows; the last row of the list has none.
    className: cn('py-3 pl-4 pr-2', !last && 'border-b border-(--ui-stroke-secondary)'),
    // Applied once when the row is expanded (NOT a hover effect): tints the whole issue — header,
    // description and sub-issues — so everything that belongs to it reads as one unit.
    style: open ? { background: EXPANDED_ROW_BG } : hover ? { background: ROW_HOVER_BG } : undefined,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    children: [
      jsxs('div', {
        // The WHOLE header row toggles (except the ellipsis area, fenced below). It is the only toggle
        // control, so it is keyboard-operable: focusable, Enter/Space, aria-expanded.
        // EVERY row in the Open and Closed lists behaves the same: parent issues and sub-issues listed flat alike.
        className: 'flex cursor-pointer items-start gap-3',
        onClick: toggle,
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        'aria-label': (open ? 'Hide' : 'Show') + ' description and sub-issues of #' + issue.number,
        onKeyDown: e => {
          // Only when the row itself has focus — Enter/Space on the link icon or ellipsis belong to them.
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            toggle()
          }
        },
        children: [
          jsx(IssueIcon, { issue, accent: true }),
          jsxs('div', {
            className: 'min-w-0 flex-1',
            children: [
              jsxs('div', {
                className: 'flex flex-wrap items-center gap-x-2 gap-y-1',
                children: [
                  jsx('span', { className: 'text-sm font-semibold', children: issue.title }),
                  jsx(IssueLinkButton, { issue }),
                  total > 0 ? jsx(SubIssuePill, { done, total }) : null,
                  issue.labels.map(l => jsx(LabelPill, { key: l.name, label: l }))
                ]
              }),
              jsx('div', {
                className: 'mt-0.5 text-xs text-(--ui-text-tertiary)',
                children: repo + '#' + issue.number + ' · ' + issue.author + ' ' + when + (issue.is_sub ? ' · sub-issue' : '')
              }),
              error ? jsx('div', { className: 'pt-1 text-xs text-(--ui-red)', children: error }) : null
            ]
          }),
          // Actions: [⋯] (its top row is "Edit"). Fence: the buttons AND the portaled menu bubble through the React tree to this
          // row, so stop clicks here — nothing in this group may toggle the row.
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1',
            style: { cursor: 'default' },
            onClick: e => e.stopPropagation(),
            children: [
              canClose
                ? jsx(CloseMenu, {
                    repo,
                    issue,
                    onClosed,
                    onUpdated: patch => onUpdated && onUpdated(issue.number, patch),
                    onError: setError,
                    onEdit: () => void beginEdit(),
                    editDisabled: formViewable,
                    onDeleted: gone
                  })
                : null
            ]
          })
        ]
      }),
      open ? jsx('div', { style: DESC_PANEL_STYLE, children: jsx(IssueDescription, { repo, issue, body, edit, setEdit, onSaved: setBody, onTitleSaved: title => onUpdated && onUpdated(issue.number, { title }), repoLabels: labels, onLabelsSaved }) }) : null,
      open
        ? jsx(SubIssueRows, {
            repo,
            parent: issue,
            subs,
            subError,
            canCreate: issue.state === 'open',
            labels,
            done,
            total,
            defaultCollapsed: collapseSubs,
            onStale,
            onSubDeleted: gone,
            // A sub-issue was closed / reopened from its ⋯ menu: update it in place (the pill, "n of m" and the open-only filter
            // follow), and have the Open/Closed counts re-read.
            onSubChanged: (sub, patch) => {
              setSubs(prev => (prev || []).map(x => (x.number === sub.number ? { ...x, ...patch } : x)))
              onStale && onStale()
            },
            onReorder: next => setSubs(next),
            onResync: () => void listSubIssues(repo, issue.number).then(setSubs, () => {}),
            onRetry: loadSubs,
            onCreated: sub => {
              if (subs === null) loadSubs()
              else setSubs(prev => prev.concat(sub))
              onStale && onStale()
            }
          })
        : null
    ]
  })
}

/** Placeholder rows shown while a list loads (first load, switching Open/Closed, a label click, a search). Each one is built to the
 *  SAME box model as a real issue row so the list does not change height when the real rows arrive:
 *    row     = py-3 (0.75rem x 2) + the content column, + a 1px divider (none after the last)
 *    column  = title line 1.25rem (text-sm's line height) + 0.125rem (mt-0.5) + meta line 1rem (text-xs's line height) = 2.375rem
 *    the ⋯ box is 2rem and the state icon 1rem + 0.125rem, both shorter than the column, so the column sets the height (= 62px + divider).
 *  The shapes mimic a row: state icon, title, link icon, pills, "repo#n · author opened …" line, and the ⋯ button. Inert (no handlers). */
const SKELETON_ROWS = [
  { title: '52%', pills: ['4rem'], meta: '34%' },
  { title: '66%', pills: ['2.75rem', '3.5rem'], meta: '28%' },
  { title: '40%', pills: [], meta: '36%' },
  { title: '58%', pills: ['3rem'], meta: '30%' }
]
const SKELETON_FILL = 'color-mix(in srgb, var(--foreground, currentColor) 14%, transparent)'
const SKELETON_DOTS = 'color-mix(in srgb, var(--foreground, currentColor) 28%, transparent)'
const SKELETON_TITLE_LINE = '1.25rem'
const SKELETON_META_LINE = '1rem'

function SkeletonRows() {
  const block = (width, height, extra) => ({ width, height, borderRadius: '9999px', background: SKELETON_FILL, flexShrink: 0, ...extra })
  return jsx('div', {
    role: 'status',
    'aria-busy': 'true',
    'aria-label': 'Loading issues',
    // animate-pulse is the app's own pulse; motion-reduce stops it for people who ask for less motion.
    className: 'animate-pulse motion-reduce:animate-none',
    children: SKELETON_ROWS.map((r, i) =>
      jsxs(
        'div',
        {
          'aria-hidden': 'true',
          className: cn('flex items-start gap-3 py-3 pl-4 pr-2', i < SKELETON_ROWS.length - 1 && 'border-b border-(--ui-stroke-secondary)'),
          children: [
            // State icon: 1rem circle, 0.125rem down like the real icon (mt-0.5).
            jsx('div', { style: block('1rem', '1rem', { marginTop: '0.125rem' }) }),
            jsxs('div', {
              className: 'min-w-0 flex-1',
              children: [
                // Title line: exactly as tall as the real title line; title, link icon, then the pills sit centred in it.
                jsxs('div', {
                  style: { display: 'flex', alignItems: 'center', gap: '0.5rem', height: SKELETON_TITLE_LINE, overflow: 'hidden' },
                  children: [
                    jsx('div', { style: block(r.title, '0.75rem', { flexShrink: 1, minWidth: '2rem' }) }),
                    jsx('div', { style: block('0.875rem', '0.875rem', { borderRadius: '0.25rem' }) }),
                    r.pills.map((w, k) => jsx('div', { key: k, style: block(w, '1.125rem') }))
                  ]
                }),
                // Meta line ("repo#12 · author opened 2d ago"): same 0.125rem gap and 1rem line as the real one.
                jsx('div', {
                  style: { marginTop: '0.125rem', height: SKELETON_META_LINE, display: 'flex', alignItems: 'center' },
                  children: jsx('div', { style: block(r.meta, '0.5rem') })
                })
              ]
            }),
            // The ⋯ menu button placeholder: same 2rem box.
            jsx('div', {
              className: 'shrink-0',
              style: { width: '2rem', height: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'center' },
              // The real ⋯ glyph (same icon and size as the menu button), a little stronger than the bars so it reads as a button.
              children: jsx(Icon, { path: KEBAB_PATH, size: 16, color: SKELETON_DOTS })
            })
          ]
        },
        i
      )
    )
  })
}

function IssueList({ repo, state, terms, labels, includeSub, collapseSubs, page, pageSize, sort, refreshKey, onPageInfo, onPageChange, onAuthProblem, onCountChange, onCountsStale }) {
  // Obeys the Settings option "Include sub-issues in Open and Closed lists": on = every issue (sub-issues appear as their own
  // rows, marked "sub-issue"); off = parent issues only, in BOTH lists and also under a label filter.
  const [issues, setIssues] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  // Bumped by every completed load. It is part of each row's key, so a fresh load ALWAYS builds fresh rows — which read their remembered
  // expanded state (ROW_OPEN) — instead of React quietly reusing an existing row of the same issue that never saw the change.
  const [gen, setGen] = useState(0)

  const load = useCallback(
    async () => {
      setLoading(true)
      setError(null)
      try {
        // ONE page. The plain list endpoint is used only for the default text with sub-issues included; a search (typed terms, a label, or
        // parent-issues-only via no:parent-issue) goes through GitHub search, which also says how many results there are in total.
        // A lone "#N" means "show issue N": looked up directly (exact, ignores the parents-only setting, costs no search quota), and only
        // shown if it is in the list being viewed (open / closed).
        const lone = lonelyIssueNumber(terms)
        if (lone !== null) {
          const one = await getIssueSlim(repo, lone)
          const shown = one && one.state === state && !isDeleted(lone) ? [one] : []
          setIssues(dropRecent(shown, state))
          setGen(g => g + 1)
          onPageInfo({ page: 1, total: shown.length, hasMore: false, viaSearch: true })
          return
        }
        const viaSearch = !!terms || !includeSub
        const r = viaSearch ? await searchIssues(repo, { state, page, perPage: pageSize, includeSub, terms, sort: sort.by, order: sort.order }) : await listIssues(repo, { state, page, perPage: pageSize, sort: sort.by, order: sort.order })
        // A search shows what GitHub matched: only drop what was just deleted / moved to the other state. The plain list also lays recent local
        // changes over page 1 (GitHub's list lags a few seconds behind a write); later pages are left exactly as fetched.
        setIssues(viaSearch || page > 1 || !isDefaultSort(sort) ? dropRecent(r.issues, state) : applyRecent(r.issues, state, includeSub))
        setGen(g => g + 1)
        onPageInfo({ page, total: r.total, hasMore: r.has_more, viaSearch })
      } catch (e) {
        setError(e.message || String(e))
        if (e.status === 401) onAuthProblem()
        setIssues([])
        onPageInfo({ page, total: null, hasMore: false, viaSearch: false })
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, state, includeSub, terms, page, pageSize, sort.by, sort.order]
  )

  useEffect(() => {
    setIssues(null)
    void load()
  }, [load, refreshKey])

  // A page that has just been emptied (its last row closed / deleted / moved, or the data shrank under us) steps back one page.
  useEffect(() => {
    if (issues !== null && issues.length === 0 && !loading && !error && page > 1) onPageChange(page - 1)
  }, [issues])

  if (issues === null) return jsx(SkeletonRows, {})

  return jsxs('div', {
    children: [
      error ? jsx('div', { className: 'whitespace-pre-wrap p-4 text-xs text-(--ui-red)', children: error }) : null,
      issues.length === 0 && !error
        ? jsx('div', {
            className: 'p-8 text-center text-sm text-(--ui-text-tertiary)',
            children: terms
              ? 'No ' + state + ' issues match that search.'
              : 'No ' + state + (includeSub ? ' issues.' : ' parent issues.')
          })
        : jsx('ul', {
            children: issues.map((i, idx) =>
              jsx(IssueRow, {
                key: gen + ':' + i.number,
                repo,
                issue: i,
                labels,
                collapseSubs,
                last: idx === issues.length - 1,
                canClose: true,
                onStale: onCountsStale,
                onClosed: n => {
                  ROW_OPEN.delete(repo + '#' + n) // it shows up in the other list collapsed
                  setIssues(prev => (prev || []).filter(x => x.number !== n))
                  // Leaving the Open list = closed; leaving the Closed list = reopened. Every row in a list counts in that list's
                  // count (the list and the count obey the same Settings option), so it is always one for one.
                  if (onCountChange) onCountChange(state === 'open' ? { open: -1, closed: 1 } : { open: 1, closed: -1 })
                },
                // Deleted issues (the row's own and/or anything below it that is also listed flat): drop them and move this list's count.
                onDeleted: nums => {
                  const removed = (issues || []).filter(x => nums.includes(x.number)).length
                  setIssues(prev => (prev || []).filter(x => !nums.includes(x.number)))
                  if (removed && onCountChange) onCountChange(state === 'open' ? { open: -removed } : { closed: -removed })
                },
                onUpdated: (n, patch) => setIssues(prev => (prev || []).map(x => (x.number === n ? { ...x, ...patch } : x)))
              })
            )
          })
    ]
  })
}

// ---------------------------------------------------------------- the issue form
// ONE form for adding and editing an issue (and for adding a sub-issue): Title, Description, a "Labels:" row, then the actions. Editing is the
// same form with the issue's current values filled in. It is presentational: the caller owns the values, the saving and the error text.

/** Space between the form's last field and its action buttons. */
const FORM_ACTIONS_GAP = '1rem'

function IssueForm({ heading, title, titleId, body, picked, options, onChange, busy, canSubmit, submitText, busyText, onSubmit, onCancel, error, notice, autoFocus }) {
  const toggle = name => onChange({ labels: picked.includes(name) ? picked.filter(n => n !== name) : picked.concat(name) })
  const submitOnCtrlEnter = e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (canSubmit && !busy) onSubmit()
    }
  }
  return jsxs('div', {
    className: 'space-y-2',
    children: [
      heading ? jsx('div', { className: 'text-xs font-semibold text-(--ui-text-secondary)', children: heading }) : null,
      jsx(FieldInput, {
        id: titleId,
        autoFocus: !!autoFocus,
        value: title,
        placeholder: 'Title',
        'aria-label': 'Issue title',
        maxLength: 256,
        disabled: busy,
        onChange: e => onChange({ title: e.target.value }),
        onKeyDown: submitOnCtrlEnter
      }),
      jsx(FieldTextarea, {
        value: body,
        rows: 10,
        disabled: busy,
        'aria-label': 'Issue description (markdown)',
        placeholder: 'Describe the issue (markdown supported)',
        style: { fontFamily: MONO, fontSize: '0.75rem', lineHeight: 1.5 },
        onChange: e => onChange({ body: e.target.value }),
        onKeyDown: submitOnCtrlEnter
      }),
      // "Labels:" sits to the LEFT of the pills, on the same row (the pills wrap under each other, not under the word).
      jsxs('div', {
        className: 'flex items-start gap-2',
        children: [
          jsx('span', { className: 'shrink-0 text-xs text-(--ui-text-quaternary)', style: { lineHeight: '1.125rem' }, children: 'Labels:' }),
          options.length === 0
            ? jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', style: { lineHeight: '1.125rem' }, children: 'This repo has no labels.' })
            : jsx('div', {
                className: 'flex min-w-0 flex-1 flex-wrap gap-1.5',
                style: { opacity: busy ? 0.6 : 1, pointerEvents: busy ? 'none' : undefined },
                children: options.map(l => jsx(LabelPill, { key: l.name, label: l, selected: picked.includes(l.name), onClick: () => toggle(l.name) }))
              })
        ]
      }),
      notice || null,
      error ? jsx('div', { className: 'whitespace-pre-wrap text-xs text-(--ui-red)', children: error }) : null,
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        // Inline margin (beats the parent's space-y-2) so there is clear air between the labels and the buttons.
        style: { marginTop: FORM_ACTIONS_GAP },
        children: [
          jsx(Button, { type: 'button', disabled: busy || !canSubmit, onClick: onSubmit, children: busy ? busyText : submitText }),
          // Cancel has the same resting look and roll state as the Settings page's Cancel button (see QuietButton).
          jsx(QuietButton, { type: 'button', disabled: busy, onClick: onCancel, children: 'Cancel' })
        ]
      })
    ]
  })
}

// ---------------------------------------------------------------- new issue

// Background / border of the inline New issue panel. The theme accent (blue-ish) tint is deliberately different from the neutral grey of the list
// bar (5% foreground) and rows, and from the faint expanded-row tint. One place to tune.
const NEW_ISSUE_PANEL_BG = 'color-mix(in srgb, var(--ui-accent) 10%, transparent)'
const NEW_ISSUE_PANEL_BORDER = 'color-mix(in srgb, var(--ui-accent) 45%, transparent)'
const NEW_ISSUE_TITLE_ID = 'gi-new-issue-title'

function NewIssueForm({ repo, labels, onCreated, onCancel }) {
  const [v, setV] = useState({ title: '', body: '', labels: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = async () => {
    if (!v.title.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const created = await createIssue(repo, { title: v.title, body: v.body, labels: v.labels })
      haptic('tap')
      host.notify({ kind: 'success', message: 'Created #' + created.number + ': ' + created.title })
      setV({ title: '', body: '', labels: [] })
      onCreated()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return jsx('div', {
    // The inline New issue panel: its own rounded frame with a tinted background and accent border, deliberately unlike the neutral list box
    // and its rows below it, so it reads as a separate thing. Sits between the search row and the list; the list stays fully usable.
    style: { background: NEW_ISSUE_PANEL_BG, border: '1px solid ' + NEW_ISSUE_PANEL_BORDER, borderRadius: '0.5rem', padding: '1rem', marginRight: RIGHT_MARGIN, marginBottom: '1rem', flex: '0 0 auto' },
    'data-new-issue-panel': true,
    children: jsx(IssueForm, {
      // Focused on open, so you can start typing the title straight away.
      autoFocus: true,
      titleId: NEW_ISSUE_TITLE_ID,
      title: v.title,
      body: v.body,
      picked: v.labels,
      options: labels,
      onChange: patch => setV(prev => ({ ...prev, ...patch })),
      busy,
      canSubmit: !!v.title.trim(),
      submitText: 'Create issue',
      busyText: 'Creating…',
      onSubmit: () => void submit(),
      onCancel,
      error
    })
  })
}

// ---------------------------------------------------------------- main view

/** Quiet text action in the header: same size/colour as the "as <login>" text, no background, no rollover. */
/** Icon-only header action (Refresh, Settings). Themed like the quiet "as <login>" text next to the repo name, with no roll state.
 *  `active` = the page that button leads to is the one showing (brighter, aria-pressed); `disabled` = not available on this page. */
function HeaderIconButton({ label, path, onClick, active, disabled }) {
  // Plain alt text only: aria-label for screen readers and the browser's own title text. No custom tooltip component.
  return jsx('button', {
    type: 'button',
    'aria-label': label,
    'aria-pressed': active === undefined ? undefined : !!active,
    title: disabled ? label + ' (not available on this page)' : label,
    disabled: !!disabled,
    onClick,
    className: active ? 'text-foreground' : 'text-(--ui-text-quaternary)',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '1.875rem',
      height: '1.875rem',
      background: 'none',
      border: 0,
      padding: 0,
      opacity: disabled ? 0.4 : 1,
      cursor: disabled ? 'default' : 'pointer'
    },
    children: jsx(Icon, { path, size: 16 })
  })
}

// What GitHub told us about each repo (private flag, login), remembered so the header can show it on every page — including Settings, where
// MainView is not mounted — without a gap that would make the header shift.
const INFO_CACHE = new Map()

/** The top nav shared by every view: title + Refresh/Settings icons, then the small repo line. Same boxes, same padding on every page, so
 *  switching views never moves it. */
function PageHeader({ repo, info, onRefresh, onSettings, settingsActive, refreshDisabled }) {
  return jsxs('div', {
    className: 'shrink-0',
    children: [
      // Title row: the plugin name on the left, the two quiet utility icons at the right. Pushed down from the top (pt-6). No divider line.
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-2 pb-0.5 pl-0 pr-4 pt-6',
        children: [
          jsx('div', { className: 'truncate text-foreground', style: { fontSize: '1.125rem', fontWeight: 700, lineHeight: '1.5rem' }, children: 'Issue Orchestration' }),
          jsx('div', { className: 'ml-auto' }),
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1',
            children: [
              jsx(HeaderIconButton, { label: 'Refresh', path: SYNC_PATH, onClick: onRefresh, disabled: refreshDisabled }),
              jsx(HeaderIconButton, { label: 'Settings', path: GEAR_PATH, onClick: onSettings, active: settingsActive })
            ]
          })
        ]
      }),
      // Repo line: small, quiet text (octocat, repo, Private, "as <login>"), all in the muted colour of the "as <login>" text.
      jsxs('div', {
        className: 'flex shrink-0 flex-wrap items-center gap-1.5 pb-1 pl-0 pr-4 text-xs text-(--ui-text-quaternary)',
        children: [
          jsx(Icon, { path: OCTOCAT_PATH, size: 12 }),
          jsx('div', { className: 'truncate', children: repo }),
          info && info.private
            ? jsx('span', {
                className: 'rounded-full border border-(--ui-stroke-secondary) px-1.5 text-[0.6875rem] leading-4',
                style: { whiteSpace: 'nowrap', flexShrink: 0 },
                children: 'Private'
              })
            : null,
          info && info.login ? jsx('div', { children: 'as ' + info.login }) : null
        ]
      })
    ]
  })
}

/** Text pagination under the list box: `‹ Previous  1 2 3 … 8  Next ›`. `count` is the number of pages when known (else null: only
 *  Previous / Next and the current page number). Quiet muted text; the current page is bolder with a faint tint; unavailable ends are dimmed
 *  with no hover state and a plain cursor. */
function Pager({ page, count, hasMore, onPage }) {
  const known = count !== null
  const last = known ? count : page + (hasMore ? 1 : 0)
  const btn = (label, target, opts) => {
    const { current, disabled, key, aria } = opts || {}
    return jsx('button', {
      key,
      type: 'button',
      disabled: !!disabled || !!current,
      'aria-label': aria,
      'aria-current': current ? 'page' : undefined,
      onClick: () => onPage(target),
      className: cn('rounded', !disabled && !current && 'hover:bg-(--ui-control-hover-background) hover:text-foreground', current ? 'font-semibold text-foreground' : ''),
      style: {
        background: current ? SUB_ROW_HOVER_BG : 'none',
        border: 0,
        padding: '0.25rem 0.5rem',
        minWidth: '1.75rem',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled || current ? 'default' : 'pointer'
      },
      children: label
    })
  }
  const nums = known ? pageWindow(page, count) : [page]
  return jsxs('nav', {
    'aria-label': 'Pagination',
    className: 'flex shrink-0 flex-wrap items-center justify-center gap-0.5 pb-4 pl-0 pr-4 text-xs text-(--ui-text-tertiary)',
    children: [
      btn('‹ Previous', page - 1, { key: 'prev', disabled: page <= 1, aria: 'Previous page' }),
      nums.map((n, i) =>
        n === '…' ? jsx('span', { key: 'gap' + i, 'aria-hidden': 'true', style: { padding: '0 0.25rem' }, children: '…' }) : btn(String(n), n, { key: 'p' + n, current: n === page, aria: 'Page ' + n })
      ),
      btn('Next ›', page + 1, { key: 'next', disabled: page >= last, aria: 'Next page' })
    ]
  })
}

// ---------------------------------------------------------------- the list bar: tabs, Labels menu, Sort menu

/** Fill of the counter bubbles. */
const BAR_BUBBLE_BG = 'color-mix(in srgb, var(--foreground, currentColor) 9%, transparent)'
// Quiet bar buttons. One height, one line-height, align-items: center: the text, the bubbles and the icons all share the same centre line.
const BAR_BTN_STYLE = { display: 'inline-flex', alignItems: 'center', gap: '0.5rem', height: '1.75rem', padding: '0 0.625rem', borderRadius: '0.375rem', border: 0, fontSize: '0.8125rem', lineHeight: '1rem', cursor: 'pointer' }

/** The words in the bar buttons (Open, Closed, Labels, Newest/Oldest). Glyphs sit about 1 CSS px lower than the centre of their line box, so next to
 *  the centred icons and chevrons they looked low. Nudged up 1px with `position: relative` — only the TEXT moves; layout, icons, chevrons and
 *  bubbles stay exactly where they are. (Measured from a screenshot at 150% scale: text centre 1.0–1.5 device px below the chevron's.) */
function BarText({ children }) {
  return jsx('span', { style: { position: 'relative', top: '-1px' }, children })
}

/** Counter bubble (the number shown to the right of Open / Closed / a menu's name). */
function CountBubble({ children }) {
  // 14px tall and at least 28px wide (was 16 x 18): wider and shorter. line-height 1 + flex centring puts the digits on the bubble's middle line; no
  // padding above or below the text.
  return jsx('span', {
    style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', minWidth: '1.75rem', height: '0.875rem', padding: '0 0.5rem', borderRadius: '9999px', background: BAR_BUBBLE_BG, fontSize: '0.6875rem', lineHeight: 1, fontWeight: 600, whiteSpace: 'nowrap' },
    children
  })
}

/** "Open" / "Closed": text plus a counter bubble. Hovering either one shows the roll state; the only cue for the current list is bold text. */
function TabButton({ label, count, active, onClick }) {
  return jsxs('button', {
    type: 'button',
    'aria-pressed': active,
    onClick,
    className: cn(active ? 'font-semibold text-foreground' : 'text-(--ui-text-tertiary)', 'hover:bg-(--ui-control-hover-background) hover:text-foreground'),
    style: BAR_BTN_STYLE,
    children: [jsx(BarText, { key: 't', children: label }), count !== undefined && count !== null ? jsx(CountBubble, { children: count.toLocaleString() }) : null]
  })
}

/** A dropdown trigger in the bar: its text, an optional icon / bubble, and a chevron. Plain quiet text — no roll state and no active styling (only
 *  Open / Closed have those). A plain helper returning a <button> (not a component): PopoverTrigger asChild must clone a real DOM element to
 *  pass it its ref and click handler. */
function menuTrigger({ children, label, open }) {
  return jsxs('button', {
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': !!open,
    'aria-label': label,
    title: label,
    className: 'text-(--ui-text-tertiary)',
    style: BAR_BTN_STYLE,
    children: [children, jsx(Icon, { path: CHEVRON_DOWN_PATH, size: 12 })]
  })
}

/** The Labels dropdown: holds every repo label as a pill. Clicking a pill toggles it (the filter logic is unchanged: it edits the search text),
 *  and the menu stays open so several can be picked. A bubble on the trigger counts the labels in use. */
function LabelsMenu({ labels, selected, onToggle, onClear }) {
  const [open, setOpen] = useState(false)
  const picked = labels.filter(l => selected.includes(l.name.toLowerCase())).length
  return jsxs(Popover, {
    open,
    onOpenChange: setOpen,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: menuTrigger({
          label: picked ? 'Labels (' + picked + ' selected)' : 'Labels',
          open,
          children: [jsx(BarText, { key: 't', children: 'Labels' }), picked ? jsx(CountBubble, { key: 'n', children: String(picked) }) : null]
        })
      }),
      jsx(PopoverContent, {
        variant: 'menu',
        align: 'end',
        className: 'p-0',
        style: { width: '20rem', maxWidth: '90vw' },
        children: jsxs('div', {
          children: [
            jsxs('div', {
              className: 'flex items-center justify-between',
              style: { padding: '0.5rem 0.75rem 0.25rem' },
              children: [
                jsx('span', { className: 'text-(--ui-text-tertiary)', style: { fontSize: '0.6875rem' }, children: 'Filter by label' }),
                // Clear all label filtering at once. Dimmed and inert (no hover, plain cursor) when no label filter is in use. Keeps the menu open.
                jsx('button', {
                  type: 'button',
                  disabled: selected.length === 0,
                  onClick: onClear,
                  'aria-label': 'Clear all label filters',
                  className: cn('rounded text-(--ui-text-tertiary)', selected.length > 0 && 'hover:bg-(--ui-control-hover-background) hover:text-foreground'),
                  style: { background: 'none', border: 0, padding: '0.125rem 0.375rem', fontSize: '0.6875rem', lineHeight: '1rem', opacity: selected.length === 0 ? 0.4 : 1, cursor: selected.length === 0 ? 'default' : 'pointer' },
                  children: 'Clear'
                })
              ]
            }),
            labels.length === 0
              ? jsx('div', { className: 'text-xs text-(--ui-text-quaternary)', style: { padding: '0.25rem 0.75rem 0.75rem' }, children: 'This repo has no labels.' })
              : jsx('div', {
                  className: 'flex flex-wrap gap-1.5 overflow-y-auto',
                  style: { padding: '0.375rem 0.75rem 0.75rem', maxHeight: '16rem' },
                  children: labels.map(l => jsx(LabelPill, { key: l.name, label: l, selected: selected.includes(l.name.toLowerCase()), onClick: () => onToggle(l.name) }))
                })
          ]
        })
      })
    ]
  })
}

/** The Sort dropdown (right side of the bar): "Sort by" Created on / Last updated, then "Order" Oldest / Newest. The trigger shows the order,
 *  like GitHub's. Picking an option applies it and closes the menu. */
function SortMenu({ sort, onChange }) {
  const [open, setOpen] = useState(false)
  const orders = [
    ['asc', 'Oldest', SORT_ASC_PATH],
    ['desc', 'Newest', SORT_DESC_PATH]
  ]
  const byLabel = (SORT_BY_OPTIONS.find(o => o[0] === sort.by) || SORT_BY_OPTIONS[0])[1]
  const current = orders.find(o => o[0] === sort.order) || orders[1]
  const row = (key, role, checked, children, onClick) =>
    jsxs('button', {
      key,
      type: 'button',
      role,
      'aria-checked': checked,
      onClick: () => {
        onClick()
        setOpen(false)
      },
      className: 'flex w-full items-center text-left hover:bg-(--ui-control-hover-background)',
      style: { gap: '0.5rem', padding: '0.3125rem 0.75rem', fontSize: '0.75rem', lineHeight: '1rem' },
      children: [jsx('span', { className: 'inline-flex w-3.5 shrink-0 justify-center', children: checked ? jsx(Icon, { path: CHECK_PATH, size: 14 }) : null }), children]
    })
  const head = t => jsx('div', { key: 'h' + t, className: 'text-(--ui-text-tertiary)', style: { fontSize: '0.6875rem', padding: '0.5rem 0.75rem 0.25rem' }, children: t })
  return jsxs(Popover, {
    open,
    onOpenChange: setOpen,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: menuTrigger({ label: 'Sort: ' + byLabel + ', ' + current[1], open, children: [jsx(Icon, { key: 'i', path: current[2], size: 14 }), jsx(BarText, { key: 't', children: current[1] })] })
      }),
      jsx(PopoverContent, {
        variant: 'menu',
        align: 'end',
        className: 'p-0',
        style: { width: '13rem' },
        children: jsxs('div', {
          role: 'menu',
          children: [
            head('Sort by'),
            SORT_BY_OPTIONS.map(([id, label]) => row(id, 'menuitemradio', sort.by === id, label, () => onChange({ ...sort, by: id }))),
            jsx('div', { key: 'sep', className: 'mx-2 my-1 border-t border-(--ui-stroke-secondary)' }),
            head('Order'),
            orders.map(([id, label, path]) =>
              row(id, 'menuitemradio', sort.order === id, [jsx(Icon, { key: 'i', path, size: 14, className: 'text-(--ui-text-tertiary)' }), label], () => onChange({ ...sort, order: id }))
            ),
            jsx('div', { key: 'pad', style: { height: '0.25rem' } })
          ]
        })
      })
    ]
  })
}

// ---------------------------------------------------------------- pinned issues (cards above the search bar)

/** One pinned issue: state icon, title (two lines), `repo#N` and its labels; the whole card shows that issue in the list (see MainView.focusIssue);
 *  its ⋯ menu has the single entry "Un-pin". */
// The pinned card whose issue is the one on show: a firmer border and a soft fill (the same fill as the Open / Closed counter bubbles).
const PINNED_ACTIVE_STYLE = { background: BAR_BUBBLE_BG, borderColor: 'color-mix(in srgb, var(--foreground, currentColor) 35%, transparent)' }

// How wide a pinned card is, so the row is always split evenly with the 0.5rem gaps counted in: three pins take a third each; one or two take half
// each (so a single pin is half the row, not the whole of it).
function pinnedCardBasis(count) {
  return count >= 3 ? 'calc((100% - 1rem) / 3)' : 'calc((100% - 0.5rem) / 2)'
}

function PinnedCard({ repo, issue, active, count, onOpen, onUnpin }) {
  const [open, setOpen] = useState(false)
  return jsxs('div', {
    role: 'button',
    tabIndex: 0,
    'aria-label': (active ? 'Showing #' : 'Show #') + issue.number + ' in the list' + (active ? ' — click to go back' : ''),
    'aria-pressed': !!active,
    'data-pinned-card': issue.number,
    onClick: () => onOpen(issue),
    onKeyDown: e => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        onOpen(issue)
      }
    },
    className: 'hover:bg-(--ui-control-hover-background)',
    style: { flex: '0 0 ' + pinnedCardBasis(count), minWidth: '12rem', boxSizing: 'border-box', display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.5rem 0.25rem 0.5rem 0.625rem', border: '1px solid var(--ui-stroke-secondary)', borderRadius: '0.5rem', cursor: 'pointer', ...(active ? PINNED_ACTIVE_STYLE : null) },
    children: [
      jsx(IssueIcon, { issue, accent: true }),
      jsxs('div', {
        className: 'min-w-0 flex-1',
        children: [
          jsx('div', { title: issue.title, style: { fontSize: '0.8125rem', fontWeight: 600, lineHeight: '1.25rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }, children: issue.title }),
          jsxs('div', {
            className: 'flex flex-wrap items-center gap-1 text-xs text-(--ui-text-quaternary)',
            style: { marginTop: '0.125rem' },
            children: [repo + '#' + issue.number, issue.labels.slice(0, 3).map(l => jsx(LabelPill, { key: l.name, label: l }))]
          })
        ]
      }),
      // Fenced: nothing in the menu (or its popup, which bubbles through React) may count as a click on the card.
      jsx('div', {
        className: 'shrink-0',
        style: { cursor: 'default' },
        onClick: e => e.stopPropagation(),
        onKeyDown: e => e.stopPropagation(),
        children: jsxs(Popover, {
          open,
          onOpenChange: setOpen,
          children: [
            jsx(PopoverTrigger, {
              asChild: true,
              children: jsx('button', {
                type: 'button',
                'aria-label': 'Pinned issue #' + issue.number + ' menu',
                title: 'Pinned issue menu',
                className: 'text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
                style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '1.5rem', height: '1.5rem', borderRadius: '0.5rem', border: 0, background: 'none', cursor: 'pointer' },
                children: jsx(Icon, { path: KEBAB_PATH, size: 14 })
              })
            }),
            jsx(PopoverContent, {
              variant: 'menu',
              align: 'end',
              className: 'p-0',
              style: { width: '10rem' },
              children: jsx(MenuRow, {
                reason: 'unpin',
                onClick: () => {
                  setOpen(false)
                  onUnpin(issue)
                }
              })
            })
          ]
        })
      })
    ]
  })
}

/** Up to 3 pinned issues, side by side above the search bar (they wrap onto more rows only when the window is narrow). Nothing at all when
 *  nothing is pinned. */
function PinnedIssues({ repo, pins, activeNumber, onOpen, onUnpin }) {
  if (!pins.length) return null
  return jsx('div', {
    role: 'list',
    'aria-label': 'Pinned issues',
    className: 'shrink-0',
    // marginBottom 0.75rem + the search row's own 0.75rem top padding = 1.5rem between the pinned cards and the search box (was 0.75rem).
    style: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem', marginBottom: '0.75rem', marginRight: RIGHT_MARGIN },
    children: pins.map(i => jsx(PinnedCard, { key: i.number, repo, issue: i, active: i.number === activeNumber, count: pins.length, onOpen, onUnpin }))
  })
}

/** The strip at the top of the list box while a single issue is on show (from a pinned card or a typed `#N`): says so, and is the way out. */
function FocusBar({ number, onExit }) {
  return jsxs('div', {
    'data-focus-bar': number,
    className: 'flex shrink-0 items-center justify-between gap-3 border-b border-(--ui-stroke-secondary) text-xs text-(--ui-text-tertiary)',
    style: { padding: '0.25rem 0.5rem 0.25rem 0.75rem' },
    children: [
      jsxs('span', { children: ['Showing issue ', jsx('span', { className: 'font-semibold text-foreground', children: '#' + number })] }),
      jsxs('button', {
        type: 'button',
        onClick: onExit,
        className: 'text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground',
        style: { display: 'inline-flex', alignItems: 'center', gap: '0.375rem', height: '1.5rem', padding: '0 0.5rem', borderRadius: '0.375rem', border: 0, background: 'none', fontSize: '0.75rem', lineHeight: '1rem', cursor: 'pointer' },
        children: ['Show all issues', jsx(Icon, { path: CLEAR_PATH, size: 12 })]
      })
    ]
  })
}

/** Full-width search box (GitHub's own search syntax). Enter or the magnifier applies it; the X puts the default text back. Clicking
 *  into it puts the caret one space after the existing text, ready to type the next term. */
// The text box and the highlight layer behind it must use IDENTICAL metrics, or the colours drift off the characters.
const SEARCH_TEXT_STYLE = { padding: '0 0.625rem', fontSize: '0.75rem', lineHeight: '1.75rem', fontFamily: 'inherit', letterSpacing: 'normal', fontWeight: 400 }
const SEARCH_HIGHLIGHT = 'var(--ui-accent, #58a6ff)'

function SearchBar({ value, prefix, onChange, onSubmit, onReset }) {
  const [focused, setFocused] = useState(false)
  const [scroll, setScroll] = useState(0) // the box scrolls sideways when the text is long; the colour layer follows it
  const syncScroll = el => setScroll(el ? el.scrollLeft : 0)
  const lockedLen = value.startsWith(prefix) ? prefix.length : 0
  const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'transparent', border: 0 }
  return jsxs('div', {
    role: 'search',
    style: {
      display: 'flex',
      alignItems: 'stretch',
      width: '100%',
      height: '1.875rem', // 30px including the 1px borders (was ~36px)
      boxSizing: 'border-box',
      border: '1px solid ' + (focused ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'),
      borderRadius: '0.375rem',
      overflow: 'hidden'
    },
    children: [
      // Colour layer + the real input stacked in one box. The input's own text is transparent (its caret and selection still show), and the
      // layer behind it draws the same text with the value half of each qualifier:value phrase coloured.
      jsxs('div', {
        title: 'The start of the search (is:issue state:open|closed) follows the Open / Closed buttons. Type your terms after it.',
        style: { position: 'relative', flex: '1 1 0%', minWidth: 0, height: '100%' },
        children: [
          jsx('div', {
            'aria-hidden': 'true',
            'data-search-highlight': true,
            style: { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', whiteSpace: 'pre', boxSizing: 'border-box', ...SEARCH_TEXT_STYLE },
            className: 'text-foreground',
            children: jsx('span', {
              style: { display: 'inline-block', transform: 'translateX(' + -scroll + 'px)' },
              children: (() => {
                // The locked front (set by the Open/Closed buttons) is drawn a little dimmer than what the user types.
                let off = 0
                return highlightParts(value).map((x, i) => {
                  off += x.t.length
                  const style = {}
                  if (x.hl) style.color = SEARCH_HIGHLIGHT
                  if (off <= lockedLen) style.opacity = 0.7
                  return jsx('span', { key: i, style: x.hl || off <= lockedLen ? style : undefined, children: x.t })
                })
              })()
            })
          }),
          jsx('input', {
            type: 'text',
            value,
            spellCheck: false,
            autoComplete: 'off',
            'aria-label': 'Search issues',
            placeholder: 'Search issues',
            className: 'text-foreground',
            // Compact: 12px text; the input fills the bar's height with no vertical padding and line-height = the inner height (28px), so the
            // text sits exactly in the middle. Transparent text: the colour layer behind it is what is seen.
            style: {
              position: 'relative',
              display: 'block',
              width: '100%',
              height: '100%',
              boxSizing: 'border-box',
              background: 'transparent',
              border: 0,
              outline: 'none',
              color: 'transparent',
              caretColor: 'var(--foreground, currentColor)',
              ...SEARCH_TEXT_STYLE
            },
            onChange: e => {
              const el = e.target
              const g = guardQuery(value, el.value, prefix)
              onChange(g.text)
              setTimeout(() => {
                if (g.text !== el.value) {
                  try {
                    el.setSelectionRange(g.caret, g.caret) // an edit was refused or adjusted: put the caret where it belongs
                  } catch (err) {}
                }
                syncScroll(el) // the box may have scrolled to keep the caret in view
              }, 0)
            },
            onScroll: e => syncScroll(e.target),
            onKeyUp: e => syncScroll(e.target),
            onSelect: e => syncScroll(e.target),
            onFocus: e => {
              setFocused(true)
              const el = e.target
              // One space after the existing text, caret at the very end (set after the click has placed it).
              const next = /\s$/.test(el.value) ? el.value : el.value + ' '
              if (next !== el.value) onChange(next)
              setTimeout(() => {
                try {
                  el.setSelectionRange(next.length, next.length)
                } catch (err) {}
                syncScroll(el)
              }, 0)
            },
            onBlur: () => setFocused(false),
            onKeyDown: e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onSubmit()
              }
            }
          })
        ]
      }),
      value
        ? jsx('button', {
            type: 'button',
            title: 'Reset the search',
            'aria-label': 'Reset the search',
            onClick: onReset,
            className: 'text-(--ui-text-tertiary) hover:text-foreground',
            style: { ...iconBtn, padding: '0 0.5rem' },
            children: jsx(Icon, { path: CLEAR_PATH, size: 14 })
          })
        : null,
      jsx('button', {
        type: 'button',
        title: 'Search',
        'aria-label': 'Search',
        // Same as pressing Enter in the box.
        onClick: onSubmit,
        className: 'text-(--ui-text-secondary) hover:text-foreground',
        // Same tint as a sub-issue row's roll state (SUB_ROW_HOVER_BG).
        style: { ...iconBtn, width: '2.25rem', borderLeft: '1px solid var(--ui-stroke-secondary)', background: SUB_ROW_HOVER_BG },
        children: jsx(Icon, { path: SEARCH_PATH, size: 14 })
      })
    ]
  })
}

function MainView({ repo, includeSub, collapseSubs, pageSize, onSettings, onAuthProblem, notice, clearNotice }) {
  const leftMargin = useLeftMargin()
  const [info, setInfo] = useState(() => INFO_CACHE.get(repo) || null)
  const [infoError, setInfoError] = useState(null)
  const [labels, setLabels] = useState([])
  const [tab, setTab] = useState('open')
  // The New issue form is a panel above the list, not a view of its own: while it is open the search, tabs and list underneath keep working.
  const [composing, setComposing] = useState(false)
  // GitHub's pinned issues (max 3): loaded on open and on Refresh, and again after anything that changes them.
  const [pins, setPins] = useState([])
  // Search bar: `queryText` is what is typed, `applied` what filters the lists (set by Enter / the magnifier / a tab switch).
  const [queryText, setQueryText] = useState(defaultQuery('open'))
  const [applied, setApplied] = useState(defaultQuery('open'))
  const terms = parseQuery(applied).terms
  // Pagination. The page belongs to ONE combination of list / search / sub-issue setting / page size: change any of them and it is page 1
  // again (derived, not an effect, so the list never fetches the old page for the new search first).
  const [sort, setSortState] = useState(() => ({ ...SORT_MEMO }))
  // The single-issue view (a pinned card, or a lone `#N` in the search box): the number on show, or null.
  const shownNumber = lonelyIssueNumber(terms)
  // What to put back on "Show all issues": the search text, tab and page from BEFORE the pinned card was clicked, and which issues the click
  // expanded (only those that were collapsed before it get collapsed again).
  const [focus, setFocus] = useState(null)
  useEffect(() => {
    if (focus && lonelyIssueNumber(terms) === null) setFocus(null)
  }, [terms])
  // Anything that means "I want to browse" (a tab, a label, the sort) leaves the single-issue view: the `#N` is dropped and the action applies to
  // the normal list.
  const withoutNumber = text => (lonelyIssueNumber(parseQuery(text).terms) !== null ? dropIssueNumber(text) : text)
  const setSort = next => {
    SORT_MEMO.by = next.by
    SORT_MEMO.order = next.order
    if (shownNumber !== null) {
      const t = withoutNumber(queryText)
      setQueryText(t)
      setApplied(t)
      setFocus(null)
    }
    setSortState(next)
  }
  const makePageKey = (t, trms) => t + '\u0000' + trms + '\u0000' + includeSub + '\u0000' + pageSize + '\u0000' + sort.by + '\u0000' + sort.order
  const pageKey = makePageKey(tab, terms)
  const [pageState, setPageState] = useState({ key: '', n: 1 })
  const page = pageState.key === pageKey ? pageState.n : 1
  // The remembered page is dropped the moment the key changes, so coming back to a list later starts at page 1 again, not where it was left.
  if (pageState.key !== pageKey) setPageState({ key: pageKey, n: 1 })
  const [pageInfo, setPageInfo] = useState(null)
  const listRef = useRef(null)
  const goPage = n => {
    setPageState({ key: pageKey, n: Math.max(1, n) })
    if (listRef.current) listRef.current.scrollTop = 0
  }
  const [refreshKey, setRefreshKey] = useState(0)
  const [countsKey, setCountsKey] = useState(0)
  const [counts, setCounts] = useState(null)
  const [ctl] = useState(() => ({ seq: 0, timer: 0, dead: false }))
  // Refresh = reload everything, counts included.
  const refresh = useCallback(() => {
    setRefreshKey(k => k + 1)
    setCountsKey(k => k + 1)
  }, [])

  const loadCounts = useCallback(() => {
    const my = ++ctl.seq // a slower, older response must never overwrite a newer one
    fetchCounts(repo, includeSub, terms).then(
      c => {
        if (!ctl.dead && my === ctl.seq) setCounts(c)
      },
      () => {} // rate-limited / offline: keep showing the last known counts, no error noise
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, includeSub, terms])

  useEffect(() => {
    ctl.dead = false
    return () => {
      ctl.dead = true
      clearTimeout(ctl.timer)
    }
  }, [])

  // (Re)load on mount, repo/label-filter change and Refresh — debounced so toggling labels cannot burn the search limit.
  useEffect(() => {
    const t = setTimeout(loadCounts, COUNT_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [loadCounts, countsKey])

  // After a local change: move the numbers now, then re-read once GitHub's index has caught up.
  const settleCounts = useCallback(() => {
    clearTimeout(ctl.timer)
    ctl.timer = setTimeout(loadCounts, COUNT_REFETCH_MS)
  }, [loadCounts])
  const bumpCounts = useCallback(
    d => {
      setCounts(c => (c ? { open: Math.max(0, c.open + (d.open || 0)), closed: Math.max(0, c.closed + (d.closed || 0)) } : c))
      settleCounts()
    },
    [settleCounts]
  )

  useEffect(() => {
    let dead = false
    setInfoError(null)
    verifyConnection(repo, CTX.storage.get(STORE_TOKEN, ''))
      .then(i => {
        INFO_CACHE.set(repo, i)
        if (!dead) setInfo(i)
      })
      .catch(e => {
        if (dead) return
        setInfoError(e.message || String(e))
        if (e.status === 401) onAuthProblem()
      })
    listLabels(repo).then(
      l => !dead && setLabels(l),
      () => !dead && setLabels([])
    )
    return () => {
      dead = true
    }
  }, [repo, refreshKey, onAuthProblem])

  const loadPins = useCallback(() => {
    listPinnedIssues(repo).then(setPins, () => setPins([]))
  }, [repo])
  useEffect(() => {
    loadPins()
  }, [loadPins, refreshKey])

  // Click a pinned card: clear every label filter, put the issue number in the search box (`is:issue state:<its state> #N`), switch to its list,
  // and show just that issue — already expanded. The `#N` search is an exact lookup (see IssueList).
  const focusIssue = issue => {
    // Clicking the card of the issue already on show goes back.
    if (shownNumber === issue.number) return exitFocus()
    const st = issue.state === 'closed' ? 'closed' : 'open'
    const next = clearLabelsInQuery(defaultQuery(st)) + ' #' + issue.number
    const key = repo + '#' + issue.number
    const wasOpen = ROW_OPEN.has(key)
    // Remember where we came from (only the FIRST click of a chain: moving from one pinned card to another still goes back to the original view).
    const base = focus || { prev: { queryText, applied, tab, page }, opened: [] }
    setFocus({ prev: base.prev, opened: wasOpen || base.opened.includes(issue.number) ? base.opened : base.opened.concat(issue.number) })
    ROW_OPEN.add(key)
    setQueryText(next)
    setApplied(next)
    setTab(st)
  }
  // "Show all issues": back to what was there before the pinned card was clicked (search text, tab, page), and the issues the click expanded
  // collapse again — only those that were collapsed before. A lone `#N` that was typed by hand has nothing to go back to: the number is just dropped.
  const exitFocus = () => {
    if (focus && focus.prev) {
      for (const n of focus.opened) ROW_OPEN.delete(repo + '#' + n)
      const pv = focus.prev
      setQueryText(pv.queryText)
      setApplied(pv.applied)
      setTab(pv.tab)
      setPageState({ key: makePageKey(pv.tab, parseQuery(pv.applied).terms), n: pv.page })
      setFocus(null)
    } else {
      const t = dropIssueNumber(queryText)
      setQueryText(t)
      setApplied(t)
      setFocus(null)
    }
  }
  const pinsApi = {
    count: pins.length,
    isPinned: n => pins.some(x => x.number === n),
    reload: loadPins,
    pin: async issue => {
      try {
        await pinIssue(repo, issue)
        haptic('tap')
        host.notify({ kind: 'success', message: 'Pinned #' + issue.number })
      } catch (e) {
        host.notify({ kind: 'error', message: e.message || String(e) })
      }
      loadPins()
    },
    unpin: async issue => {
      try {
        await unpinIssue(repo, issue)
        haptic('tap')
        host.notify({ kind: 'success', message: 'Un-pinned #' + issue.number })
      } catch (e) {
        host.notify({ kind: 'error', message: e.message || String(e) })
      }
      loadPins()
    }
  }

  // Switching Open <-> Closed keeps the text (including anything typed but not yet submitted) and points its state tokens at the new list.
  const goTab = id => {
    const next = withState(withoutNumber(queryText), id)
    setQueryText(next)
    setApplied(next)
    setTab(id)
    setFocus(null)
  }
  const submitSearch = () => {
    const { state: want, terms: typed } = parseQuery(queryText)
    if (want && want !== tab) {
      // A state: typed AFTER the locked front (e.g. "state:closed") moves to that list, and the text is rebuilt with the new front.
      const next = defaultQuery(want) + (typed ? ' ' + typed : '')
      setQueryText(next)
      setApplied(next)
      setTab(want)
      return
    }
    setApplied(queryText)
  }
  const resetSearch = () => {
    const d = defaultQuery(tab === 'closed' ? 'closed' : 'open')
    setQueryText(d)
    setApplied(d)
    setFocus(null)
  }

  // A label pill edits the search text (label:<name>, one space apart) and applies it at once; the list and the counts then follow
  // the search like any other term. Pills show as pressed while their token is in the text.
  const inQuery = queryLabels(queryText)
  const toggleLabel = n => {
    const next = toggleLabelInQuery(withoutNumber(queryText), n)
    setQueryText(next)
    setApplied(next)
    setFocus(null)
  }
  const clearLabels = () => {
    const next = clearLabelsInQuery(queryText)
    setQueryText(next)
    setApplied(next)
  }

  // Pager: the number of pages comes from the search total when the list was fetched by search, else from the Open/Closed count. Until a
  // total is known (or if the count could not be read) only Previous / Next show, driven by whether GitHub has another page.
  const pinfo = pageInfo && pageInfo.key === pageKey ? pageInfo : null
  const total = pinfo ? (pinfo.total !== null && pinfo.total !== undefined ? pinfo.total : counts ? counts[tab] : null) : null
  const pageCount = total !== null && total !== undefined ? Math.max(1, Math.ceil(total / pageSize)) : null
  const showPager = !infoError && !!pinfo && (pageCount !== null ? pageCount > 1 : page > 1 || pinfo.hasMore)

  // "New issue" is styled EXACTLY like "Save" on the settings view: the plain default <Button> (no variant,
  // no size, no inline styling) — so it is the app's own primary button in every theme.
  const newIssueBtn = jsx(Button, {
    key: 'new',
    type: 'button',
    'aria-pressed': composing,
    onClick: () => {
      haptic('tap')
      // A toggle: opens the form panel, and closes it again when it is already showing (like Cancel, an unsent draft is discarded).
      setComposing(c => !c)
    },
    children: 'New issue'
  })

  return jsx(PinsContext.Provider, {
    value: pinsApi,
    children: jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    // One left margin for the entire list view (notices, title, repo line, search, Open/Closed bar, rows, skeleton): they all share this edge.
    style: { paddingLeft: leftMargin },
    children: [
      notice
        ? jsxs('div', {
            className: 'flex shrink-0 items-start gap-2 border-b border-(--ui-stroke-secondary) px-4 py-2 text-xs text-(--ui-orange)',
            children: [
              jsx('div', { className: 'flex-1', children: notice }),
              jsx(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: clearNotice, children: 'Dismiss' })
            ]
          })
        : null,

      infoError
        ? jsxs('div', {
            className: 'shrink-0 space-y-2 p-4 text-xs',
            children: [
              jsx('div', { className: 'whitespace-pre-wrap text-(--ui-red)', children: infoError }),
              jsx(Button, { type: 'button', size: 'sm', onClick: onSettings, children: 'Open settings' })
            ]
          })
        : null,

      jsx(PageHeader, { repo, info, onRefresh: refresh, onSettings }),

      !infoError && pins.length ? jsx(PinnedIssues, { repo, pins, activeNumber: shownNumber, onOpen: focusIssue, onUnpin: pinsApi.unpin }) : null,

      // Search (stretches to fill the row), then the New issue button.
      jsxs('div', {
        className: 'flex shrink-0 items-center pb-6 pl-0 pr-4 pt-3',
        children: [
          !infoError ? jsx('div', { className: 'min-w-0 flex-1', children: jsx(SearchBar, { value: queryText, prefix: defaultQuery(tab === 'closed' ? 'closed' : 'open'), onChange: setQueryText, onSubmit: submitSearch, onReset: resetSearch }) })
            : jsx('div', { className: 'flex-1' }),
          // New issue sits right of the search box (like GitHub's Issues page). Where the search box is hidden (connection error) the spacer above
          // keeps it at the right edge, so it stays in one consistent place.
          jsx('div', { className: 'shrink-0', style: { marginLeft: '0.75rem' }, children: newIssueBtn })
        ]
      }),

      // The New issue panel (own frame and background), between the search row and the list box.
      composing && !infoError
        ? jsx(NewIssueForm, {
            repo,
            labels,
            onCreated: () => {
              setComposing(false)
              goTab('open') // the new issue is open: show the Open list
              setRefreshKey(k => k + 1) // reload the list; the count moves optimistically (a fresh read would be stale)
              bumpCounts({ open: 1 })
            },
            onCancel: () => setComposing(false)
          })
        : null,

      // ONE rounded, bordered box around the Open / Closed / Labels bar and the issue list (like GitHub's Issues list). overflow-hidden clips the
      // bar's tint and the rows' hover/expanded tints to the rounded corners. The box wraps its content (it only reaches the bottom of the window
      // when there are enough rows to need the room, and then the list scrolls inside it). The 1rem right and bottom margins belong to the box.
      jsxs('div', {
        className: 'flex min-h-0 flex-col overflow-hidden border border-(--ui-stroke-secondary)',
        // flex: 0 1 auto = as tall as its content and no taller (the box does NOT stretch to the bottom of the window); when the rows need more
        // room than the window has, it shrinks to fit and the rows scroll inside it.
        style: { borderRadius: '0.5rem', marginRight: RIGHT_MARGIN, marginBottom: showPager ? '0.5rem' : '1rem', flex: '0 1 auto' },
        children: [
          // The list bar. Left: Open / Closed, each a text button with a counter bubble (no icons). Right: the Labels menu and the Sort menu.
          jsxs('div', {
            className: 'flex shrink-0 items-center gap-1 border-b border-(--ui-stroke-secondary) py-1.5 pl-3 pr-2',
            // Row background: the same tint as a sub-issue row's roll state.
            style: { background: SUB_ROW_HOVER_BG },
            children: [
              jsx(TabButton, { label: 'Open', count: counts ? counts.open : undefined, active: tab === 'open', onClick: () => { haptic('tap'); goTab('open') } }),
              jsx(TabButton, { label: 'Closed', count: counts ? counts.closed : undefined, active: tab === 'closed', onClick: () => { haptic('tap'); goTab('closed') } }),
              jsx('div', { className: 'ml-auto' }),
              !infoError ? jsx(LabelsMenu, { labels, selected: inQuery, onToggle: toggleLabel, onClear: clearLabels }) : null,
              !infoError ? jsx(SortMenu, { sort, onChange: setSort }) : null
            ]
          }),

          shownNumber !== null && !infoError ? jsx(FocusBar, { number: shownNumber, onExit: exitFocus }) : null,

          jsx('div', {
            // Content height, shrinking (and scrolling) only when the box is squeezed by the window.
            ref: listRef,
            className: 'min-h-0 overflow-y-auto',
            style: { flex: '0 1 auto' },
            children: infoError ? null : jsx(IssueList, { key: tab, repo, state: tab, terms, labels, includeSub, collapseSubs, page, pageSize, sort, onPageInfo: i => setPageInfo({ ...i, key: pageKey }), onPageChange: goPage, refreshKey, onAuthProblem, onCountChange: bumpCounts, onCountsStale: settleCounts })
          })
        ]
      }),

      // Text pagination, below the rounded box (hidden when everything fits on one page).
      showPager ? jsx(Pager, { page, count: pageCount, hasMore: !!(pinfo && pinfo.hasMore), onPage: goPage }) : null
    ]
  })
  })
}

/** CTX is null for an instant while the plugin is reloaded/disabled; a still-mounted old view must not throw on it. */
function GithubIssuesPage() {
  return CTX ? jsx(GithubIssuesPageInner, {}) : jsx('div', { className: 'p-6 text-sm text-(--ui-text-tertiary)', children: 'Issue Orchestration is reloading…' })
}

function GithubIssuesPageInner() {
  const read = () => ({ repo: CTX.storage.get(STORE_REPO, ''), hasToken: !!CTX.storage.get(STORE_TOKEN, '') })
  const [cfg, setCfg] = useState(read)
  const [prefs, setPrefs] = useState(readPrefs)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState(null)
  const complete = !!(cfg.repo && cfg.hasToken)
  const openSettings = useCallback(() => setEditing(true), [])

  // The tab and the docked panel are separate mounts of this page: when either saves, the other re-reads the shared storage.
  const sync = useValue(SYNC)
  useEffect(() => {
    if (!sync) return
    setCfg(read())
    setPrefs(readPrefs())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync])

  if (!complete || editing) {
    return jsx(SetupScreen, {
      first: !complete,
      // The same top nav as the list view (Settings view only). Refresh has nothing to refresh here; the gear shows as current and takes you back.
      header: complete
        ? jsx(PageHeader, { repo: cfg.repo, info: INFO_CACHE.get(cfg.repo), onRefresh: () => {}, refreshDisabled: true, onSettings: () => setEditing(false), settingsActive: true })
        : null,
      initialRepo: cfg.repo,
      hasToken: cfg.hasToken,
      onSaved: (next, warning) => {
        setCfg(next)
        setPrefs(readPrefs()) // SetupScreen has just written them
        setNotice(warning || null)
        setEditing(false)
      },
      onCancel: () => setEditing(false),
      onTokenRemoved: () => {
        setCfg(c => ({ ...c, hasToken: false }))
        setEditing(false)
      }
    })
  }
  return jsx(MainView, {
    repo: cfg.repo,
    includeSub: prefs.includeSub,
    collapseSubs: prefs.collapseSubs,
    pageSize: prefs.pageSize,
    onSettings: openSettings,
    onAuthProblem: openSettings,
    notice,
    clearNotice: () => setNotice(null)
  })
}

// ---------------------------------------------------------------- plugin wiring

function isRouteHash() {
  try {
    const h = String(window.location.hash || '')
    const p = h.startsWith('#') ? h.slice(1) : h
    return p === ROUTE || p.startsWith(ROUTE + '?') || p.startsWith(ROUTE + '/')
  } catch (e) {
    return false
  }
}

// ---------------------------------------------------------------------------------------------------------------
// OPENING. The UI lives in a main-zone workspace tab (host.openWorkspace) so a focused session tile cannot cover it.
// What the host actually does (apps/desktop, read from source) — and what this code is built around:
//  * openWorkspace registers a pane and "reveals" it, but a reveal is a NO-OP until the app's layout tree exists.
//    Calling it once at plugin start can therefore register a tab that is never brought to the front.
//  * The route page (/github-issues) stays mounted, hidden, behind an active tab — and is what the user sees if
//    the tab is closed or never appears. It must therefore never be a dead end.
//  * A pane's `render` is mounted as a component TYPE, so re-registering with a new function remounts the whole UI.
// So: one stable render function; opening is idempotent (skipped while the tab is actually on screen); the route page
// watches `host.paneVisibility` (true only while the tab is really visible), retries a bounded number of times, and
// shows the real UI inline whenever the tab is not on screen. A tab the user closed is never re-opened behind their back.
// ---------------------------------------------------------------------------------------------------------------

const PANE_ID = 'plugin-workspace:' + WORKSPACE_ID

// Bumped whenever Settings saves (or the token is removed): mounted views re-read storage, and the dock registration follows the setting.
const SYNC = atom(0)
function bumpSync() {
  SYNC.set(SYNC.get() + 1)
}

// The docked right-side panel: the same page, mounted in a 'right' pane. Stable render function (the host mounts it as a component type).
const renderDock = () => jsx(DockContext.Provider, { value: true, children: jsx(GithubIssuesPage, {}) })
const NEVER_VISIBLE = atom(false)
const OPEN_RETRY_MS = [0, 250, 700, 1400, 2500, 4000]
const INLINE_AFTER_MS = 1800

// Stable identity: the host mounts this as a component type, so a new function per open() would remount the UI.
const renderWorkspace = () => jsx(GithubIssuesPage, {})

const canWatchPane = () => typeof host.openWorkspace === 'function' && typeof host.paneVisibility === 'function'

function paneShown() {
  try {
    return typeof host.paneVisibility === 'function' && !!host.paneVisibility(PANE_ID).get()
  } catch (e) {
    return false
  }
}

/** Open as a main-zone workspace tab. Idempotent: does nothing while the tab is already on screen. */
function createOpener() {
  let closeWorkspace = null
  let reported = false
  const open = opts => {
    const quiet = !!(opts && opts.quiet)
    try {
      if (typeof host.openWorkspace === 'function') {
        if (paneShown()) return
        if (!quiet) {
          try {
            haptic('tap')
          } catch (e) {}
        }
        closeWorkspace = host.openWorkspace(WORKSPACE_ID, {
          title: 'Issue Orchestration',
          minWidth: '28rem',
          render: renderWorkspace,
          onClose: () => {
            closeWorkspace = null
          }
        })
        try {
          if (!isRouteHash()) host.navigate(ROUTE)
        } catch (e) {}
        return
      }
      host.navigate(ROUTE)
    } catch (e) {
      // One toast, not one per retry.
      if (!reported) {
        reported = true
        try {
          host.notifyError(e, 'Issue Orchestration failed to open')
        } catch (err) {}
      }
    }
  }
  const dispose = () => {
    try {
      if (typeof closeWorkspace === 'function') closeWorkspace()
    } catch (e) {}
    closeWorkspace = null
  }
  return { open, dispose }
}

/**
 * The route page. Never a dead end:
 *  - tab on screen            -> a placeholder (it is hidden behind the tab anyway)
 *  - tab not (yet) on screen  -> "Opening…" while we retry for a moment, then the REAL UI inline
 *  - tab was on screen, then closed/hidden by the user -> the real UI inline, and we do not re-open it
 */
function RouteBridge({ open }) {
  const watch = canWatchPane()
  const visible = useValue(watch ? host.paneVisibility(PANE_ID) : NEVER_VISIBLE)
  const [inline, setInline] = useState(!watch)
  const seen = useRef(false)

  useEffect(() => {
    if (!watch) return
    if (visible) {
      seen.current = true
      setInline(false)
    } else if (seen.current) {
      setInline(true)
    }
  }, [visible, watch])

  useEffect(() => {
    if (!watch) {
      open()
      return
    }
    let dead = false
    const timers = OPEN_RETRY_MS.map(ms =>
      setTimeout(() => {
        if (!dead && !seen.current && !paneShown()) open({ quiet: ms > 0 })
      }, ms)
    )
    timers.push(
      setTimeout(() => {
        if (!dead && !paneShown()) setInline(true)
      }, INLINE_AFTER_MS)
    )
    return () => {
      dead = true
      timers.forEach(clearTimeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!watch || (inline && !visible)) return jsx(GithubIssuesPage, {})

  return jsxs('div', {
    className: 'grid h-full place-items-center p-6 text-sm text-(--ui-text-tertiary)',
    children: [
      jsx('div', { children: visible ? 'Issue Orchestration is open in its own tab.' : 'Opening Issue Orchestration…' }),
      !visible ? jsx(Button, { type: 'button', size: 'sm', variant: 'ghost', onClick: () => setInline(true), children: 'Show here instead' }) : null
    ]
  })
}

export default {
  id: ID,
  name: 'Issue Orchestration',
  description: 'Browse, create and close GitHub issues with label filtering. Token stays on this PC.',
  register(ctx) {
    setCtx(ctx)
    const { open, dispose: disposeOpen } = createOpener()
    ctx.onDispose(() => {
      disposeOpen()
      if (CTX === ctx) setCtx(null)
    })

    // Sidebar path-only navigation → also front the workspace tab. Only the OFF→ON transition opens it: a tab the
    // user closed while staying on the route is not re-opened behind their back.
    let last = ''
    const tick = () => {
      const on = isRouteHash() ? 'on' : 'off'
      if (on === last) return
      last = on
      if (on === 'on') open()
    }
    tick() // also covers a cold start already on the route; the route page keeps retrying if the layout is not ready yet
    ctx.addEventListener(window, 'hashchange', tick)
    ctx.setInterval(tick, 400)

    // Persistent dock: while the Settings option is on, a right-side pane is registered on every plugin load (so it is there at Desktop
    // start); turning it off disposes the registration. uncloseable: closing a plugin's only pane would disable the whole plugin.
    let disposeDock = null
    const syncDock = () => {
      const want = readPrefs().dock
      if (want && !disposeDock) {
        disposeDock = ctx.register({
          id: 'dock',
          area: 'panes',
          title: 'Issue Orchestration',
          data: { placement: 'right', width: '420px', uncloseable: true },
          render: renderDock
        })
      } else if (!want && disposeDock) {
        disposeDock()
        disposeDock = null
      }
    }
    syncDock()
    const stopSync = SYNC.listen(syncDock)
    ctx.onDispose(() => {
      stopSync()
      if (disposeDock) disposeDock()
      disposeDock = null
    })

    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, title: 'Issue Orchestration', data: { path: ROUTE }, render: () => jsx(RouteBridge, { open }) },
      // codicon "github" is the octocat mark.
      { id: 'nav', area: SIDEBAR_NAV_AREA, order: 85, data: { path: ROUTE, label: 'Issue Orchestration', codicon: 'github' } },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'github-issues.open',
          label: 'Open Issue Orchestration',
          keywords: ['github', 'issues', 'orchestration', 'bug', 'label', 'octocat'],
          run: () => open()
        }
      }
    ])
  }
}
