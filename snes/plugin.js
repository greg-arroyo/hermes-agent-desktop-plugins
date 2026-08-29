/**
 * SNES — local ROM launcher for Hermes Desktop
 *
 * Proven path: snes-smoke-test.html works in Chromium with direct embed.
 * This plugin uses the SAME contract (no iframe) on the /snes route page.
 *
 * - ROM: user file picker → blob: URL only (never uploaded / never retained by us)
 * - EmulatorJS: official CDN loader, only after ROM selected
 * - Core: snes → snes9x
 * - Sidebar: "SNES" + controller pad icon
 *
 * Windows: %LOCALAPPDATA%\hermes\desktop-plugins\snes\plugin.js
 * Ctrl+K → Reload desktop plugins
 */
import {
  Button,
  cn,
  EmptyState,
  haptic,
  host,
  PALETTE_AREA,
  ROUTES_AREA,
  Separator,
  SIDEBAR_NAV_AREA,
  Tip
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'snes'
const ROUTE = '/snes'
const CDN = 'https://cdn.emulatorjs.org/stable/data/'
const LOADER = CDN + 'loader.js'
const CORE = 'snes'
const EXTS = ['smc', 'sfc', 'fig', 'gd3', 'gd7', 'dx2', 'bsx', 'swc', 'zip']
const GAME_SEL = '#hermes-snes-game'

const PAD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
  '<rect x="1.5" y="4.5" width="13" height="7" rx="2.2" fill="white"/>' +
  '<rect x="3.6" y="7.15" width="2.4" height="0.7" fill="#000"/>' +
  '<rect x="4.45" y="6.3" width="0.7" height="2.4" fill="#000"/>' +
  '<rect x="7" y="8.15" width="0.85" height="0.35" rx="0.1" fill="#000"/>' +
  '<rect x="8.1" y="8.15" width="0.85" height="0.35" rx="0.1" fill="#000"/>' +
  '<circle cx="11.1" cy="6.55" r="0.5" fill="#000"/>' +
  '<circle cx="10.25" cy="7.4" r="0.5" fill="#000"/>' +
  '<circle cx="11.95" cy="7.4" r="0.5" fill="#000"/>' +
  '<circle cx="11.1" cy="8.25" r="0.5" fill="#000"/>' +
  '</svg>'

function padMask() {
  return (
    'url("data:image/svg+xml,' +
    encodeURIComponent(PAD_SVG) +
    '") center / contain no-repeat'
  )
}

function Pad({ size = 16, className }) {
  const s = typeof size === 'number' ? size + 'px' : size
  return jsx('span', {
    'aria-hidden': true,
    className: cn('inline-block shrink-0', className),
    style: {
      width: s,
      height: s,
      backgroundColor: 'currentColor',
      WebkitMask: padMask(),
      mask: padMask()
    }
  })
}

function installNavIcon() {
  if (typeof document === 'undefined') return () => {}
  // Idempotent singleton — avoid stacking observers on hot reload
  if (window.__hermesSnesNavIcon && typeof window.__hermesSnesNavIcon.dispose === 'function') {
    try {
      window.__hermesSnesNavIcon.dispose()
    } catch (e) {}
  }

  document.querySelectorAll('style[data-snes-nav-icon]').forEach(n => n.remove())

  const st = document.createElement('style')
  st.setAttribute('data-snes-nav-icon', '1')
  st.textContent = `
/* Collapse stock play-circle on SNES nav rows */
[data-snes-host="1"] > i.codicon,
[data-snes-host="1"] i.codicon {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
  overflow: hidden !important;
  position: absolute !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
[data-snes-host="1"] > i.codicon::before {
  content: none !important;
}
/* Injected pad — real SVG, themes via currentColor */
span[data-snes-pad-el="1"] {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 1rem !important;
  height: 1rem !important;
  min-width: 1rem !important;
  min-height: 1rem !important;
  flex-shrink: 0 !important;
  color: inherit !important;
  opacity: 0.72 !important;
  line-height: 0 !important;
}
span[data-snes-pad-el="1"] svg {
  width: 1rem !important;
  height: 1rem !important;
  display: block !important;
  fill: currentColor !important;
}
`
  document.head.appendChild(st)

  // Inline SVG pad (visible body + cutouts). Uses currentColor.
  const PAD_INNER =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path fill="currentColor" d="M3 4.75h10a1.75 1.75 0 0 1 1.75 1.75v2.6c0 1.35-.9 2.55-2.2 3-.35.12-.72.2-1.1.2H4.55c-.38 0-.75-.08-1.1-.2C2.15 11.65 1.25 10.45 1.25 9.1V6.5A1.75 1.75 0 0 1 3 4.75z"/>' +
    // d-pad (cut with darker via opacity path - use holes punched with composite)
    '<path fill="#000" fill-opacity=".45" d="M4.35 7.35h2.3v.85h-.75v.75h-.8v-.75h-.75z"/>' +
    '<path fill="#000" fill-opacity=".45" d="M7.15 8.2h.9v.4h-.9zm1.15 0h.9v.4h-.9z"/>' +
    '<circle cx="11.05" cy="6.55" r=".48" fill="#000" fill-opacity=".45"/>' +
    '<circle cx="10.2" cy="7.4" r=".48" fill="#000" fill-opacity=".45"/>' +
    '<circle cx="11.9" cy="7.4" r=".48" fill="#000" fill-opacity=".45"/>' +
    '<circle cx="11.05" cy="8.25" r=".48" fill="#000" fill-opacity=".45"/>' +
    '</svg>'

  function isSnesNavButton(btn) {
    if (!btn || btn.tagName !== 'BUTTON') return false
    // Tour hook from contributed nav
    if (btn.querySelector('[data-tour="sidebar-nav-snes:nav"], [data-tour*="snes:nav"]')) return true
    // Label text
    const spans = btn.querySelectorAll('span')
    for (let i = 0; i < spans.length; i++) {
      const t = (spans[i].textContent || '').replace(/\s+/g, ' ').trim()
      if (t === 'SNES') return true
    }
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim()
    return t === 'SNES' || t.startsWith('SNES ')
  }

  function findSnesButtons() {
    const out = []
    // Prefer explicit sidebar menu buttons
    document.querySelectorAll('[data-slot="sidebar-menu-button"], button[data-sidebar="menu-button"], button').forEach(btn => {
      if (isSnesNavButton(btn)) out.push(btn)
    })
    return out
  }

  function ensurePad(btn) {
    if (!btn || !btn.isConnected) return
    btn.setAttribute('data-snes-host', '1')

    // Hide play-circle hard
    btn.querySelectorAll('i.codicon').forEach(icon => {
      icon.style.setProperty('display', 'none', 'important')
      icon.setAttribute('aria-hidden', 'true')
    })

    let pad = null
    for (let c = btn.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && c.getAttribute && c.getAttribute('data-snes-pad-el') === '1') {
        pad = c
        break
      }
    }
    if (!pad) {
      pad = document.createElement('span')
      pad.setAttribute('data-snes-pad-el', '1')
      pad.setAttribute('aria-hidden', 'true')
      pad.innerHTML = PAD_INNER
      // Place before the label span / after nothing
      const label =
        btn.querySelector('[data-tour*="snes:nav"]') ||
        btn.querySelector('span.min-w-0') ||
        btn.querySelector('span')
      if (label && label.parentNode === btn) btn.insertBefore(pad, label)
      else btn.insertBefore(pad, btn.firstChild)
    } else if (!pad.querySelector('svg')) {
      pad.innerHTML = PAD_INNER
    }
  }

  const tick = () => {
    findSnesButtons().forEach(ensurePad)
  }

  tick()
  const mo = new MutationObserver(() => {
    if (tick._raf) return
    tick._raf = requestAnimationFrame(() => {
      tick._raf = 0
      tick()
    })
  })
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
  const timers = [0, 16, 50, 100, 250, 500, 1000, 2000, 4000, 8000].map(ms => setTimeout(tick, ms))
  const iv = setInterval(tick, 750)

  const dispose = () => {
    mo.disconnect()
    clearInterval(iv)
    timers.forEach(clearTimeout)
    if (tick._raf) cancelAnimationFrame(tick._raf)
    document.querySelectorAll('span[data-snes-pad-el="1"]').forEach(n => n.remove())
    document.querySelectorAll('[data-snes-host="1"]').forEach(n => n.removeAttribute('data-snes-host'))
    st.remove()
    if (window.__hermesSnesNavIcon && window.__hermesSnesNavIcon.dispose === dispose) {
      window.__hermesSnesNavIcon = null
    }
  }

  window.__hermesSnesNavIcon = { dispose, tick }
  return dispose
}

function extOf(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function isRom(file) {
  return EXTS.includes(extOf(file.name))
}

function fmt(n) {
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1048576).toFixed(2) + ' MB'
}

/** Patch EmulatorJS instance methods that touch Module before it exists. */
function hardenInstance(emu) {
  if (!emu || emu.__hermesHardened) return
  const wrap = (key, fn) => {
    const inner = emu[key]
    if (typeof inner !== 'function') return
    emu[key] = function () {
      try {
        return fn.call(this, inner, arguments)
      } catch (e) {
        console.warn('[snes]', key, e)
      }
    }
  }
  wrap('setVolume', function (inner, args) {
    const volume = args[0]
    this.volume = volume
    this.muted = volume === 0
    // EmulatorJS does `this.Module.AL` without optional chaining — guard it.
    if (!this.Module) return
    try {
      return inner.apply(this, args)
    } catch (e) {
      console.warn('[snes] setVolume', e)
    }
  })
  wrap('checkStarted', function (inner, args) {
    if (!this.Module || !this.Module.AL) return
    return inner.apply(this, args)
  })
  wrap('checkSupportedOpts', function (inner, args) {
    if (!this.gameManager) return
    return inner.apply(this, args)
  })
  if (emu.gameManager) {
    const gm = emu.gameManager
    const rst = gm.restart
    if (typeof rst === 'function') {
      gm.restart = function () {
        try {
          if (!this.functions || typeof this.functions.restart !== 'function') return
          return rst.apply(this, arguments)
        } catch (e) {
          console.warn('[snes] restart', e)
        }
      }
    }
  }
  emu.__hermesHardened = true
}

/** One-time load of official loader.js (and thus emulator.min.js). */
function loadLoaderScript() {
  return new Promise((resolve, reject) => {
    if (window.__hermesSnesLoaderOk && window.EmulatorJS) {
      resolve('cached')
      return
    }
    const existing = document.querySelector('script[data-hermes-snes-loader]')
    if (existing) {
      if (window.EmulatorJS) {
        window.__hermesSnesLoaderOk = true
        resolve('cached')
        return
      }
      existing.addEventListener('load', () => {
        window.__hermesSnesLoaderOk = true
        resolve('fresh')
      })
      existing.addEventListener('error', () => reject(new Error('loader failed')))
      return
    }
    const s = document.createElement('script')
    s.src = LOADER
    s.async = true
    s.setAttribute('data-hermes-snes-loader', '1')
    s.onload = () => {
      window.__hermesSnesLoaderOk = true
      resolve('fresh')
    }
    s.onerror = () => reject(new Error('Failed to load ' + LOADER))
    document.head.appendChild(s)
  })
}

/**
 * Start EmulatorJS the same way the working smoke test does:
 * set window.EJS_* then load loader.js (or new EmulatorJS if already present).
 */
function startEmulator({ romUrl, romName, onLog, onStarted, onError }) {
  // Clean prior instance globals that confuse re-entry
  try {
    if (window.EJS_emulator && typeof window.EJS_emulator.callEvent === 'function') {
      try {
        window.EJS_emulator.callEvent('exit')
      } catch (e) {}
    }
  } catch (e) {}

  window.EJS_player = GAME_SEL
  window.EJS_core = CORE
  window.EJS_pathtodata = CDN
  window.EJS_gameUrl = romUrl
  window.EJS_gameName = romName
  window.EJS_startOnLoaded = true
  window.EJS_mouse = false
  window.EJS_multitap = false
  window.EJS_biosUrl = ''
  window.EJS_volume = 0.5
  window.EJS_threads = false
  window.EJS_disableAutoLang = true
  window.EJS_softLoad = 0
  window.EJS_DEBUG_XX = false
  window.EJS_defaultOptions = { 'save-state-location': 'download' }

  window.EJS_ready = function () {
    onLog && onLog('ready')
    try {
      hardenInstance(window.EJS_emulator)
      if (window.EJS_emulator && window.EJS_emulator.Module) {
        // safe volume apply once Module exists
        const v = window.EJS_emulator.volume || 0.5
        if (typeof window.EJS_emulator.setVolume === 'function') {
          window.EJS_emulator.setVolume(v)
        }
      }
    } catch (e) {
      onLog && onLog('ready harden: ' + e)
    }
  }

  window.EJS_onGameStart = function () {
    onLog && onLog('started')
    try {
      hardenInstance(window.EJS_emulator)
    } catch (e) {}
    onStarted && onStarted()
  }

  // Patch prototype before construction if class already present
  try {
    if (window.EmulatorJS && window.EmulatorJS.prototype) {
      const P = window.EmulatorJS.prototype
      if (!P.__hermesProtoGuard) {
        const bind = P.bindListeners
        P.bindListeners = function () {
          if (typeof bind === 'function') bind.apply(this, arguments)
          // setVolume is assigned inside bindListeners — harden immediately
          hardenInstance(this)
          const self = this
          const iv = setInterval(() => {
            hardenInstance(self)
            if (self.Module) clearInterval(iv)
          }, 50)
          setTimeout(() => clearInterval(iv), 15000)
        }
        P.__hermesProtoGuard = true
      }
    }
  } catch (e) {}

  return loadLoaderScript()
    .then(mode => {
      if (mode === 'fresh') {
        // loader.js IIFE already did `new EmulatorJS(EJS_player, config)` using our globals.
        onLog && onLog('loader fresh — using constructed instance')
        const wait = setInterval(() => {
          if (window.EJS_emulator) {
            clearInterval(wait)
            hardenInstance(window.EJS_emulator)
            onLog && onLog('EmulatorJS instance live')
          }
        }, 30)
        setTimeout(() => clearInterval(wait), 20000)
        return
      }

      // Re-entry: script already on page — construct a new instance against the host node.
      if (!window.EmulatorJS) {
        onError && onError('EmulatorJS class missing after loader')
        return
      }
      const el = document.querySelector(GAME_SEL)
      if (el) el.innerHTML = ''
      try {
        const config = {
          gameUrl: window.EJS_gameUrl,
          dataPath: CDN,
          system: CORE,
          gameName: window.EJS_gameName,
          startOnLoad: true,
          volume: 0.5,
          threads: false,
          defaultOptions: window.EJS_defaultOptions
        }
        window.EJS_emulator = new window.EmulatorJS(GAME_SEL, config)
        hardenInstance(window.EJS_emulator)
        if (typeof window.EJS_ready === 'function') {
          window.EJS_emulator.on('ready', window.EJS_ready)
        }
        if (typeof window.EJS_onGameStart === 'function') {
          window.EJS_emulator.on('start', window.EJS_onGameStart)
        }
        onLog && onLog('EmulatorJS constructed (re-entry)')
      } catch (e) {
        onError && onError(String(e && e.message ? e.message : e))
      }
    })
    .catch(err => {
      onError && onError(String(err && err.message ? err.message : err))
    })
}

function stopEmulator() {
  try {
    if (window.EJS_emulator) {
      try {
        window.EJS_emulator.callEvent && window.EJS_emulator.callEvent('exit')
      } catch (e) {}
      try {
        if (window.EJS_emulator.gameManager && window.EJS_emulator.gameManager.toggleMainLoop) {
          window.EJS_emulator.gameManager.toggleMainLoop(0)
        }
      } catch (e) {}
    }
  } catch (e) {}
  window.EJS_emulator = null
  window.EJS_ready = null
  window.EJS_onGameStart = null
  const el = document.querySelector(GAME_SEL)
  if (el) el.innerHTML = ''
}

function SnesPage() {
  const inputRef = useRef(null)
  const blobRef = useRef(null)
  const [meta, setMeta] = useState(null)
    const [playing, setPlaying] = useState(false)
    const [error, setError] = useState(null)
    // bump to force a clean game host node
    const [mountId, setMountId] = useState(0)

    const revoke = useCallback(() => {
      if (blobRef.current) {
        try {
          URL.revokeObjectURL(blobRef.current)
        } catch (e) {}
        blobRef.current = null
      }
    }, [])

    const eject = useCallback(() => {
      stopEmulator()
      revoke()
      setMeta(null)
      setPlaying(false)
      setError(null)
      setMountId(m => m + 1)
      if (inputRef.current) inputRef.current.value = ''
      host.notify({ kind: 'info', message: 'ROM ejected — blob revoked, emulator stopped.' })
    }, [revoke])

    useEffect(() => {
      return () => {
        stopEmulator()
        revoke()
      }
    }, [revoke])

    // Keep nav pad alive (React may wipe injected nodes on layout churn)
    useEffect(() => {
      if (window.__hermesSnesNavIcon && typeof window.__hermesSnesNavIcon.tick === 'function') {
        window.__hermesSnesNavIcon.tick()
      } else {
        installNavIcon()
      }
      const t = setTimeout(() => {
        if (window.__hermesSnesNavIcon && window.__hermesSnesNavIcon.tick) {
          window.__hermesSnesNavIcon.tick()
        }
      }, 200)
      return () => clearTimeout(t)
    }, [])

    // Surface real emulator failures only (not noisy AL race notes)
    useEffect(() => {
      const onErr = ev => {
        const m = String((ev && ev.message) || '')
        if (!m) return
        if (/reading 'AL'/.test(m)) return
        if (/snes|EJS|Emulator|wasm|Module/i.test(m)) setError(m)
      }
      window.addEventListener('error', onErr)
      return () => window.removeEventListener('error', onErr)
    }, [])

    const onFile = useCallback(
      async e => {
        const file = e.target.files && e.target.files[0]
        if (!file) return
        if (!isRom(file)) {
          setError('Need a SNES ROM (' + EXTS.map(x => '.' + x).join(', ') + ')')
          if (inputRef.current) inputRef.current.value = ''
          return
        }

        stopEmulator()
        revoke()

        const url = URL.createObjectURL(file)
        blobRef.current = url
        setMeta({ name: file.name, size: file.size })
        setError(null)
        setPlaying(true)
        setMountId(m => m + 1)
        haptic('tap')
        if (inputRef.current) inputRef.current.value = ''

        // Wait a tick so React mounts #hermes-snes-game
        await new Promise(r => setTimeout(r, 30))

        const hostEl = document.querySelector(GAME_SEL)
        if (!hostEl) {
          setError('Game host element missing')
          return
        }

        startEmulator({
          romUrl: url,
          romName: file.name,
          onLog: () => {},
          onStarted: () => setError(null),
          onError: msg => setError(msg)
        })
      },
      [revoke]
    )

    return jsxs('div', {
      className: 'flex h-full min-h-0 flex-col',
      children: [
        jsxs('div', {
          className:
            'flex shrink-0 flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2',
          children: [
            jsxs('div', {
              className: 'flex min-w-0 flex-1 items-center gap-2',
              children: [
                jsx(Pad, { size: 16, className: 'text-(--ui-text-tertiary)' }),
                jsx('div', {
                  className: 'truncate text-sm font-medium',
                  children: meta ? meta.name : 'SNES'
                }),
                meta
                  ? jsx('span', {
                      className: 'text-xs text-(--ui-text-quaternary)',
                      children: fmt(meta.size)
                    })
                  : null
              ]
            }),
            jsx('input', {
              ref: inputRef,
              type: 'file',
              accept: EXTS.map(x => '.' + x).join(','),
              className: 'hidden',
              onChange: onFile
            }),
            jsx(Button, {
              type: 'button',
              size: 'sm',
              variant: 'secondary',
              onClick: () => {
                haptic('tap')
                inputRef.current && inputRef.current.click()
              },
              children: meta ? 'Choose another' : 'Choose ROM'
            }),
            meta
              ? jsx(Tip, {
                  label: 'Stop emulator and forget ROM blob',
                  children: jsx(Button, {
                    type: 'button',
                    size: 'sm',
                    variant: 'ghost',
                    onClick: () => {
                      haptic('tap')
                      eject()
                    },
                    children: 'Eject'
                  })
                })
              : null
          ]
        }),

        error
          ? jsx('div', {
              className:
                'shrink-0 border-b border-(--ui-stroke-secondary) px-3 py-2 text-xs text-(--ui-text-secondary) whitespace-pre-wrap',
              children: error
            })
          : null,

        playing
          ? // EmulatorJS owns this node (clears innerHTML). Keep it empty for React.
            jsx('div', {
              key: mountId,
              id: 'hermes-snes-game',
              className: 'min-h-0 w-full flex-1 bg-black',
              suppressHydrationWarning: true
            })
          : jsxs('div', {
              className:
                'flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6',
              children: [
                jsx(Pad, { size: 48, className: 'text-(--ui-text-quaternary)' }),
                jsx(EmptyState, {
                  title: 'Local SNES ROM',
                  description:
                    'Pick a local .sfc / .smc. EmulatorJS snes9x loads from the official CDN only after you choose a file. Nothing is uploaded.'
                }),
                jsx(Button, {
                  type: 'button',
                  onClick: () => {
                    haptic('tap')
                    inputRef.current && inputRef.current.click()
                  },
                  children: jsxs('span', {
                    className: 'inline-flex items-center gap-2',
                    children: [jsx(Pad, { size: 14 }), 'Choose local ROM']
                  })
                }),
                jsx(Separator, { className: 'w-56 max-w-full' }),
                jsxs('ul', {
                  className: cn(
                    'max-w-md list-disc space-y-1 pl-5 text-xs text-(--ui-text-quaternary)'
                  ),
                  children: [
                    jsx('li', { children: 'Core: snes → snes9x @ cdn.emulatorjs.org/stable' }),
                    jsx('li', {
                      children: 'Extensions: ' + EXTS.map(x => '.' + x).join(' ')
                    })
                  ]
                })
              ]
            })
      ]
    })
  }

export default {
  id: ID,
  name: 'SNES',
  description:
    'Local SNES ROMs via EmulatorJS snes9x. CDN after pick; ROM never leaves this PC.',
  register(ctx) {
    const stop = installNavIcon()
    if (typeof ctx.onDispose === 'function') {
      ctx.onDispose(() => {
        stop()
        stopEmulator()
      })
    }

    ctx.i18n.register({ en: { nav: 'SNES', open: 'Open SNES' } })

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: ROUTE },
        render: () => jsx(SnesPage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 80,
        data: { path: ROUTE, label: 'SNES', codicon: 'play-circle' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'snes.open',
          label: 'Open SNES',
          keywords: ['snes', 'rom', 'emulator', 'snes9x'],
          run: () => host.navigate(ROUTE)
        }
      }
    ])
  }
}
