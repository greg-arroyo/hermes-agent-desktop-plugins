# SNES — Hermes Desktop plugin (local ROM launcher)

Self-contained Hermes **desktop** plugin: play a **local** SNES ROM with EmulatorJS (`snes` → snes9x).

## Privacy / load contract

- ROM comes only from the user’s file picker (`.smc`, `.sfc`, …).
- EmulatorJS loads from the **official CDN** (`cdn.emulatorjs.org/stable`) **only after** a ROM is chosen.
- ROM is exposed as an in-memory `blob:` URL; **Eject** revokes it. Not uploaded, not written to plugin storage by us.
- No game files are bundled.

## Install (Windows Desktop)

Desktop plugins load on the **machine running Electron**, not the remote gateway:

```text
%LOCALAPPDATA%\hermes\desktop-plugins\snes\plugin.js
```

```powershell
$dir = Join-Path $env:LOCALAPPDATA "hermes\desktop-plugins\snes"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item .\plugin.js (Join-Path $dir "plugin.js") -Force
```

Then **Ctrl+K → Reload desktop plugins**.

## Files

| File | Purpose |
|------|---------|
| `plugin.js` | Current working desktop plugin |
| `plugin.js.sha256` | Checksum of current `plugin.js` |
| `snes-smoke-test.html` | Standalone Chrome smoke test (no Hermes) |

## Layout / UX notes

- Route: `/snes`
- Sidebar label: **SNES** (controller pad icon injected over the default codicon)
- Direct embed (no iframe) — matches the working smoke-test path inside Electron

## Later: GitHub

Sensible publish shapes (discuss when ready):

1. **Standalone repo** e.g. `snes-hermes-desktop-plugin` with `plugin.js` + this README + MIT/license note (EmulatorJS is separate; this ships no cores).
2. **Gist** of `plugin.js` for a quick one-file share.
3. **Hermes plugin install link** (`hermes://plugin/install?…`) only if packaged as a full plugin repo Hermes can clone.

Do **not** put ROMs or copyrighted game dumps in any public repo.
