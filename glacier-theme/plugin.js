/**
 * Glacier — flat, colorful dark theme for Hermes Desktop
 *
 * Palette from Tyriar/vscode-theme-glacier (VS Code port of Joey Figaro’s
 * Glacier Sublime theme): https://github.com/Tyriar/vscode-theme-glacier
 * Dark ambiance is the authentic Glacier look. Light ambiance is a derived
 * ice-surface pair so Desktop light/dark toggle still works.
 *
 * Install (Windows Desktop):
 *   %LOCALAPPDATA%\hermes\desktop-plugins\glacier-theme\plugin.js
 * Then: Ctrl+K → "Reload desktop plugins"
 * Then: Settings → Appearance → pick "Glacier"
 * Quit fully and relaunch once so boot-time resolve can see the seeded palette.
 *
 * Why dual-write?
 * Theme *name* is stored in localStorage, but plugin themes only exist after the
 * runtime loader runs. Boot-time normalizeSkin() calls resolveTheme() before
 * plugins load — unknown names fall back to the default skin, so Glacier would
 * look like it "reset" every launch. Marketplace/user themes live in
 * hermes-desktop-user-themes-v1 and resolve synchronously at boot. We mirror
 * the Glacier definition into that store so the chosen name survives relaunch.
 *
 * Linux host copy is for backup/versioning only — Windows Desktop does not
 * load plugins from the remote gateway.
 */
import { THEMES_AREA } from '@hermes/plugin-sdk'

const ID = 'glacier-theme'
const USER_THEMES_KEY = 'hermes-desktop-user-themes-v1'

// Core surfaces (tmTheme global settings)
const G_BG = '#0E151B' // editor background
const G_BG_DEEP = '#0C1217' // gutter / deeper chrome
const G_BG_RAISED = '#141C24' // cards / popovers
const G_LINE = '#20262B' // line highlight
const G_GUIDE = '#1B2735' // guides / muted surfaces
const G_INACTIVE = '#23323F' // inactive selection / secondary
const G_BORDER = '#263445' // grey-dark-1
const G_FG = '#EFEFEF' // primary text
const G_FG_BRIGHT = '#FFFFFF'
const G_COMMENT = '#515C68' // muted text
const G_GUTTER_FG = '#263445'

// Accents (syntax + UI from Glacier / color-conversion.md)
const G_BLUE = '#3CADD7' // entity / storage.type — primary accent
const G_BLUE_DEEP = '#266B85' // tag punctuation / light-mode primary
const G_CYAN = '#5EEBB8' // find highlight / support
const G_MINT = '#76FFCD' // bright cyan-green
const G_GREEN = '#4ABE95' // inherited class / insert
const G_GREEN_DIM = '#43AE88'
const G_YELLOW = '#FFE792' // caret / constants / strings
const G_YELLOW_SOFT = '#F7F09D'
const G_ORANGE = '#FFB454' // regexp
const G_ORANGE_HOT = '#F57542'
const G_RED = '#D7503C' // keyword / destructive
const G_PINK = '#D73C4D' // variable
const G_SELECTION = '#612924' // selection background
const G_PALE = '#AFC4DB' // pale blue (light accents)
const G_BLACK1 = '#1B2127' // ANSI black

// Light ambiance — ice surface derived from Glacier accents (not in upstream tmTheme)
const L_BG = '#F3F6F9'
const L_BG_CARD = '#FFFFFF'
const L_BG_MUTED = '#E6ECF2'
const L_BG_SIDE = '#E8EEF4'
const L_FG = '#0E151B'
const L_FG_MUTED = '#515C68'
const L_BORDER = '#C5D0DB'
const L_SECONDARY = '#D5DEE8'
const L_BUBBLE = '#D3E8F2'

const EMOJI =
  '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'

/** @type {import('@hermes/plugin-sdk').DesktopTheme} */
const glacierTheme = {
  name: 'glacier',
  label: 'Glacier',
  description: 'Flat, colorful — Tyriar/Joey Figaro Glacier (dark + ice light)',
  colors: {
    // Bright / ice ambiance
    background: L_BG,
    foreground: L_FG,
    card: L_BG_CARD,
    cardForeground: L_FG,
    muted: L_BG_MUTED,
    mutedForeground: L_FG_MUTED,
    popover: L_BG_CARD,
    popoverForeground: L_FG,
    primary: G_BLUE_DEEP,
    primaryForeground: G_FG_BRIGHT,
    secondary: L_SECONDARY,
    secondaryForeground: L_FG,
    accent: L_BG_MUTED,
    accentForeground: L_FG,
    border: L_BORDER,
    input: L_BG_CARD,
    ring: G_BLUE_DEEP,
    midground: G_BLUE_DEEP,
    midgroundForeground: G_FG_BRIGHT,
    composerRing: G_BLUE_DEEP,
    destructive: G_RED,
    destructiveForeground: G_FG_BRIGHT,
    sidebarBackground: L_BG_SIDE,
    sidebarBorder: L_BORDER,
    userBubble: L_BUBBLE,
    userBubbleBorder: L_BORDER
  },
  darkColors: {
    // Authentic Glacier dark ambiance
    background: G_BG,
    foreground: G_FG,
    card: G_BG_RAISED,
    cardForeground: G_FG,
    muted: G_GUIDE,
    mutedForeground: G_COMMENT,
    popover: G_BG_RAISED,
    popoverForeground: G_FG,
    primary: G_BLUE,
    primaryForeground: G_BG,
    secondary: G_INACTIVE,
    secondaryForeground: G_FG,
    accent: G_LINE,
    accentForeground: G_FG,
    border: G_BORDER,
    input: G_GUIDE,
    ring: G_BLUE,
    midground: G_BLUE,
    midgroundForeground: G_BG,
    composerRing: G_BLUE,
    destructive: G_RED,
    destructiveForeground: G_FG_BRIGHT,
    sidebarBackground: G_BG_DEEP,
    sidebarBorder: G_GUIDE,
    userBubble: G_INACTIVE,
    userBubbleBorder: G_BORDER
  },
  typography: {
    fontSans:
      '"Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif, ' +
      EMOJI,
    fontMono: 'Menlo, Monaco, "SF Mono", "Cascadia Code", "Courier Prime", monospace, ' + EMOJI
  },
  terminal: {
    // Light terminal — ice surface, Glacier ANSI accents
    foreground: L_FG,
    cursor: G_BLUE_DEEP,
    selectionBackground: L_BUBBLE,
    black: G_BLACK1,
    red: G_RED,
    green: G_GREEN,
    yellow: G_ORANGE,
    blue: G_BLUE_DEEP,
    magenta: G_PINK,
    cyan: G_GREEN_DIM,
    white: '#D8DEE6',
    brightBlack: G_COMMENT,
    brightRed: G_ORANGE_HOT,
    brightGreen: G_CYAN,
    brightYellow: G_YELLOW,
    brightBlue: G_BLUE,
    brightMagenta: G_PINK,
    brightCyan: G_MINT,
    brightWhite: G_FG_BRIGHT
  },
  darkTerminal: {
    // Dark terminal — Glacier editor + saturated accents
    foreground: G_FG,
    cursor: G_YELLOW,
    selectionBackground: G_SELECTION,
    black: G_BLACK1,
    red: G_RED,
    green: G_GREEN,
    yellow: G_YELLOW,
    blue: G_BLUE,
    magenta: G_PINK,
    cyan: G_CYAN,
    white: G_FG,
    brightBlack: G_COMMENT,
    brightRed: G_ORANGE_HOT,
    brightGreen: G_MINT,
    brightYellow: G_YELLOW_SOFT,
    brightBlue: G_PALE,
    brightMagenta: G_PINK,
    brightCyan: G_CYAN,
    brightWhite: G_FG_BRIGHT
  }
}

/** Seed the boot-time user-theme store so resolveTheme('glacier') works before plugins run. */
function seedBootTimeUserTheme() {
  try {
    const raw = window.localStorage.getItem(USER_THEMES_KEY)
    const record = raw ? JSON.parse(raw) : {}
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      window.localStorage.setItem(USER_THEMES_KEY, JSON.stringify({ glacier: glacierTheme }))
      return
    }
    // Always refresh so palette edits in this file ship on next load.
    // Only touch the glacier key — leave nord and other user themes alone.
    record.glacier = glacierTheme
    window.localStorage.setItem(USER_THEMES_KEY, JSON.stringify(record))
  } catch {
    // Restricted storage — live THEMES_AREA registration still works in-session.
  }
}

export default {
  id: ID,
  name: 'Glacier Theme',
  description: 'Flat colorful Glacier light/dark theme for Hermes Desktop (Tyriar/Joey Figaro)',
  register(ctx) {
    seedBootTimeUserTheme()
    ctx.register({
      id: 'glacier',
      area: THEMES_AREA,
      data: glacierTheme
    })
  }
}
