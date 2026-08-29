/**
 * Nord — arctic, north-bluish palette for Hermes Desktop
 *
 * Official colors from https://www.nordtheme.com
 * Light = bright ambiance (Snow Storm surfaces, Polar Night text)
 * Dark  = dark ambiance (Polar Night surfaces, Snow Storm text)
 *
 * Install (Windows Desktop):
 *   %LOCALAPPDATA%\hermes\desktop-plugins\nord-theme\plugin.js
 * Then: Ctrl+K → "Reload desktop plugins"
 * Then: Settings → Appearance → pick "Nord"
 *
 * Linux host copy is for backup/versioning only — Windows Desktop does not
 * load plugins from the remote gateway.
 */
import { THEMES_AREA } from '@hermes/plugin-sdk'

const ID = 'nord-theme'

// Polar Night
const N0 = '#2E3440'
const N1 = '#3B4252'
const N2 = '#434C5E'
const N3 = '#4C566A'
// Snow Storm
const N4 = '#D8DEE9'
const N5 = '#E5E9F0'
const N6 = '#ECEFF4'
// Frost
const N7 = '#8FBCBB'
const N8 = '#88C0D0'
const N9 = '#81A1C1'
const N10 = '#5E81AC'
// Aurora
const N11 = '#BF616A'
const N12 = '#D08770'
const N13 = '#EBCB8B'
const N14 = '#A3BE8C'
const N15 = '#B48EAD'

const EMOJI =
  '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji'

/** @type {import('@hermes/plugin-sdk').DesktopTheme} */
const nordTheme = {
  name: 'nord',
  label: 'Nord',
  description: 'Arctic, north-bluish — Polar Night & Snow Storm',
  colors: {
    // Bright ambiance
    background: N6,
    foreground: N0,
    card: N5,
    cardForeground: N0,
    muted: '#E2E6EE',
    mutedForeground: N3,
    popover: N6,
    popoverForeground: N0,
    primary: N10,
    primaryForeground: '#FFFFFF',
    secondary: '#D2D8E4',
    secondaryForeground: N0,
    accent: N4,
    accentForeground: N0,
    border: N4,
    input: N5,
    ring: N10,
    midground: N10,
    midgroundForeground: '#FFFFFF',
    composerRing: N10,
    destructive: N11,
    destructiveForeground: '#FFFFFF',
    sidebarBackground: N5,
    sidebarBorder: N4,
    userBubble: '#C9D6E8',
    userBubbleBorder: N4
  },
  darkColors: {
    // Dark ambiance
    background: N0,
    foreground: N4,
    card: N1,
    cardForeground: N4,
    muted: N1,
    mutedForeground: N3,
    popover: N1,
    popoverForeground: N4,
    primary: N8,
    primaryForeground: N0,
    secondary: N2,
    secondaryForeground: N4,
    accent: N2,
    accentForeground: N4,
    border: N2,
    input: N1,
    ring: N8,
    midground: N8,
    midgroundForeground: N0,
    composerRing: N8,
    destructive: N11,
    destructiveForeground: N6,
    sidebarBackground: '#242933',
    sidebarBorder: N1,
    userBubble: N2,
    userBubbleBorder: N3
  },
  typography: {
    fontSans:
      '"Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif, ' +
      EMOJI,
    fontMono: 'Menlo, Monaco, "SF Mono", "Cascadia Code", "Courier Prime", monospace, ' + EMOJI
  },
  terminal: {
    foreground: N0,
    cursor: N0,
    selectionBackground: N4,
    black: N1,
    red: N11,
    green: N14,
    yellow: N13,
    blue: N9,
    magenta: N15,
    cyan: N8,
    white: N5,
    brightBlack: N3,
    brightRed: N11,
    brightGreen: N14,
    brightYellow: N13,
    brightBlue: N9,
    brightMagenta: N15,
    brightCyan: N7,
    brightWhite: N6
  },
  darkTerminal: {
    foreground: N4,
    cursor: N4,
    selectionBackground: N2,
    black: N1,
    red: N11,
    green: N14,
    yellow: N13,
    blue: N9,
    magenta: N15,
    cyan: N8,
    white: N5,
    brightBlack: N3,
    brightRed: N11,
    brightGreen: N14,
    brightYellow: N13,
    brightBlue: N9,
    brightMagenta: N15,
    brightCyan: N7,
    brightWhite: N6
  }
}

export default {
  id: ID,
  name: 'Nord Theme',
  description: 'Arctic Nord light/dark theme for Hermes Desktop',
  register(ctx) {
    ctx.register({
      id: 'nord',
      area: THEMES_AREA,
      data: nordTheme
    })
  }
}
