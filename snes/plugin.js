/**
 * SNES — local ROM launcher for Hermes Desktop
 *
 * - ROM: user file picker → blob: URL only (never uploaded / never retained)
 * - EmulatorJS: official CDN loader, only after ROM selected
 * - Core: snes → snes9x
 * - Open path: host.openWorkspace (forces a visible main-zone tab). The older
 *   ROUTES_AREA + sidebar path alone can look like a dead click when a session
 *   tile is focused in the main zone (#72602 class) — openWorkspace reveals.
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
const WORKSPACE_ID = 'snes'
const CDN = 'https://cdn.emulatorjs.org/stable/data/'
const LOADER = CDN + 'loader.js'
const CORE = 'snes'
const EXTS = ['smc', 'sfc', 'fig', 'gd3', 'gd7', 'dx2', 'bsx', 'swc', 'zip']
const GAME_SEL = '#hermes-snes-game'

/**
 * Sidebar / empty-state gamepad — traced from user reference silhouette
 * (wide body, left D-pad, center select/start, right face-button diamond).
 * evenodd cutouts + currentColor so it tracks the app theme.
 */
const PAD_PATH =
  'M5.5 3.2H26.5C29.4 3.2 31.5 5.3 31.5 8.2V11.8C31.5 14.7 29.4 16.8 26.5 16.8H5.5' +
  'C2.6 16.8 0.5 14.7 0.5 11.8V8.2C0.5 5.3 2.6 3.2 5.5 3.2Z' +
  'M8.2 6.4H10V8.2H11.8V10H10V11.8H8.2V10H6.4V8.2H8.2Z' +
  'M14.9 9.2m-0.95 0a0.95 0.55 0 1 0 1.9 0a0.95 0.55 0 1 0-1.9 0' +
  'M17.5 9.2m-0.95 0a0.95 0.55 0 1 0 1.9 0a0.95 0.55 0 1 0-1.9 0' +
  'M23.4 6.15m-1.2 0a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0' +
  'M21.0 8.55m-1.2 0a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0' +
  'M25.8 8.55m-1.2 0a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0' +
  'M23.4 10.95m-1.2 0a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0'

const PAD_SVG_INNER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 20" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="' +
  PAD_PATH +
  '"/></svg>'

const PAD_SVG_MASK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 20">' +
  '<path fill="white" fill-rule="evenodd" d="' +
  PAD_PATH +
  '"/></svg>'

function padMask() {
  return (
    'url("data:image/svg+xml,' +
    encodeURIComponent(PAD_SVG_MASK) +
    '") center / contain no-repeat'
  )
}

function Pad({ size = 16, className }) {
  const s = typeof size === 'number' ? size + 'px' : size
  // Slightly wider than tall — matches the real controller aspect.
  const w = typeof size === 'number' ? size * 1.35 + 'px' : size
  return jsx('span', {
    'aria-hidden': true,
    className: cn('inline-block shrink-0', className),
    style: {
      width: w,
      height: s,
      backgroundColor: 'currentColor',
      WebkitMask: padMask(),
      mask: padMask()
    }
  })
}

/**
 * Light-touch sidebar icon swap: hide the stock codicon and inject the
 * reference gamepad. Scoped + idempotent — no full-document thrash loops.
 */
function installNavIcon() {
  if (typeof document === 'undefined') return () => {}

  if (window.__hermesSnesNavIcon && typeof window.__hermesSnesNavIcon.dispose === 'function') {
    try {
      window.__hermesSnesNavIcon.dispose()
    } catch (e) {}
  }

  document.querySelectorAll('style[data-snes-nav-icon]').forEach(n => n.remove())

  const st = document.createElement('style')
  st.setAttribute('data-snes-nav-icon', '1')
  st.textContent = `
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
span[data-snes-pad-el="1"] {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  width: 1.05rem !important;
  height: 0.78rem !important;
  min-width: 1.05rem !important;
  flex-shrink: 0 !important;
  color: inherit !important;
  opacity: 0.78 !important;
  line-height: 0 !important;
}
span[data-snes-pad-el="1"] svg {
  width: 1.05rem !important;
  height: 0.78rem !important;
  display: block !important;
}
`
  document.head.appendChild(st)

  function isSnesNavButton(btn) {
    if (!btn || btn.tagName !== 'BUTTON') return false
    if (btn.querySelector('[data-tour="sidebar-nav-snes:nav"], [data-tour*="snes:nav"]')) return true
    const spans = btn.querySelectorAll('span')
    for (let i = 0; i < spans.length; i++) {
      const t = (spans[i].textContent || '').replace(/\s+/g, ' ').trim()
      if (t === 'SNES') return true
    }
    const t = (btn.textContent || '').replace(/\s+/g, ' ').trim()
    return t === 'SNES' || t.startsWith('SNES ')
  }

  function ensurePad(btn) {
    if (!btn || !btn.isConnected) return
    if (btn.getAttribute('data-snes-host') !== '1') btn.setAttribute('data-snes-host', '1')

    let pad = btn.querySelector('span[data-snes-pad-el="1"]')
    if (!pad) {
      pad = document.createElement('span')
      pad.setAttribute('data-snes-pad-el', '1')
      pad.setAttribute('aria-hidden', 'true')
      pad.innerHTML = PAD_SVG_INNER
      const label =
        btn.querySelector('[data-tour*="snes:nav"]') ||
        btn.querySelector('span.min-w-0') ||
        btn.querySelector('span')
      if (label && label.parentNode === btn) btn.insertBefore(pad, label)
      else btn.insertBefore(pad, btn.firstChild)
    } else if (!pad.querySelector('svg')) {
      pad.innerHTML = PAD_SVG_INNER
    }
  }

  const tick = () => {
    document
      .querySelectorAll('[data-slot="sidebar-menu-button"], button[data-sidebar="menu-button"], button')
      .forEach(btn => {
        if (isSnesNavButton(btn)) ensurePad(btn)
      })
  }

  tick()
  let raf = 0
  const mo = new MutationObserver(() => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      tick()
    })
  })
  // Observe sidebar region only when possible; fall back to body.
  const root =
    document.querySelector('[data-tour="sessions-sidebar"]') ||
    document.querySelector('[data-sidebar="sidebar"]') ||
    document.body
  mo.observe(root, { childList: true, subtree: true })
  const timers = [0, 50, 200, 600, 1500].map(ms => setTimeout(tick, ms))

  const dispose = () => {
    mo.disconnect()
    timers.forEach(clearTimeout)
    if (raf) cancelAnimationFrame(raf)
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

function startEmulator({ romUrl, romName, onLog, onStarted, onError }) {
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

  try {
    if (window.EmulatorJS && window.EmulatorJS.prototype) {
      const P = window.EmulatorJS.prototype
      if (!P.__hermesProtoGuard) {
        const bind = P.bindListeners
        P.bindListeners = function () {
          if (typeof bind === 'function') bind.apply(this, arguments)
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
        className: 'flex shrink-0 flex-wrap items-center gap-2 border-b border-(--ui-stroke-secondary) px-3 py-2',
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
        ? jsx('div', {
            key: mountId,
            id: 'hermes-snes-game',
            className: 'min-h-0 w-full flex-1 bg-black',
            suppressHydrationWarning: true
          })
        : jsxs('div', {
            className: 'flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6',
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
                className: cn('max-w-md list-disc space-y-1 pl-5 text-xs text-(--ui-text-quaternary)'),
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

/** Keep hash / path checks aligned with HashRouter (#/snes). */
function isSnesHash() {
  try {
    const h = String(window.location.hash || '')
    const path = h.startsWith('#') ? h.slice(1) : h
    return path === ROUTE || path.startsWith(ROUTE + '?') || path.startsWith(ROUTE + '/')
  } catch (e) {
    return false
  }
}

/**
 * Open SNES as a main-zone workspace tab (preferred) so a focused session tile
 * cannot swallow the navigation. Falls back to hash route on older desktops.
 */
function createOpenSnes() {
  let closeWorkspace = null
  let opening = false

  const open = () => {
    if (opening) return
    opening = true
    try {
      haptic('tap')
    } catch (e) {}

    try {
      if (typeof host.openWorkspace === 'function') {
        // Re-open same id refreshes + re-fronts (no duplicate tab).
        closeWorkspace = host.openWorkspace(WORKSPACE_ID, {
          title: 'SNES',
          minWidth: '28rem',
          headerVeto: true,
          render: () => jsx(SnesPage, {}),
          onClose: () => {
            closeWorkspace = null
            stopEmulator()
          }
        })
        // Keep the contributed route in sync so sidebar active state lights up.
        try {
          if (!isSnesHash()) host.navigate(ROUTE)
        } catch (e) {}
        return
      }

      host.navigate(ROUTE)
    } catch (e) {
      console.error('[snes] open failed', e)
      try {
        host.notifyError(e, 'SNES failed to open')
      } catch (err) {}
    } finally {
      // Allow a later re-click to re-front.
      setTimeout(() => {
        opening = false
      }, 50)
    }
  }

  const dispose = () => {
    try {
      if (typeof closeWorkspace === 'function') closeWorkspace()
    } catch (e) {}
    closeWorkspace = null
    stopEmulator()
  }

  return { open, dispose }
}

/** When the host sidebar navigates to /snes (path-only), also force openWorkspace. */
function watchSnesRoute(open) {
  let last = ''
  const tick = () => {
    const on = isSnesHash()
    const key = on ? 'on' : 'off'
    if (key === last) return
    last = key
    if (on) open()
  }
  tick()
  window.addEventListener('hashchange', tick)
  window.addEventListener('popstate', tick)
  // Sidebar navigate may set hash without a hashchange in some shells.
  const iv = setInterval(tick, 400)
  return () => {
    window.removeEventListener('hashchange', tick)
    window.removeEventListener('popstate', tick)
    clearInterval(iv)
  }
}

/** Thin route body: if someone lands on /snes without openWorkspace, show page + open tab. */
function SnesRouteBridge({ open }) {
  useEffect(() => {
    open()
  }, [open])
  // openWorkspace hosts the real UI; keep a lightweight fallback if it is missing.
  if (typeof host.openWorkspace === 'function') {
    return jsx('div', {
      className: 'grid h-full place-items-center p-6 text-sm text-(--ui-text-tertiary)',
      children: 'Opening SNES…'
    })
  }
  return jsx(SnesPage, {})
}

export default {
  id: ID,
  name: 'SNES',
  description: 'Local SNES ROMs via EmulatorJS snes9x. CDN after pick; ROM never leaves this PC.',
  register(ctx) {
    const { open, dispose: disposeOpen } = createOpenSnes()
    const stopWatch = watchSnesRoute(open)
    const stopIcon = installNavIcon()

    if (typeof ctx.onDispose === 'function') {
      ctx.onDispose(() => {
        stopWatch()
        stopIcon()
        disposeOpen()
      })
    }

    ctx.i18n.register({ en: { nav: 'SNES', open: 'Open SNES' } })

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        title: 'SNES',
        data: { path: ROUTE },
        render: () => jsx(SnesRouteBridge, { open })
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
          keywords: ['snes', 'rom', 'emulator', 'snes9x', 'game'],
          run: () => open()
        }
      }
    ])

    // Cold start already on #/snes
    if (isSnesHash()) open()
  }
}
