# Nord Theme — Hermes Desktop plugin

Arctic, north-bluish palette from [nordtheme.com](https://www.nordtheme.com).

- **Light:** Snow Storm surfaces, Polar Night text, Frost `#5E81AC` accent
- **Dark:** Polar Night surfaces, Snow Storm text, Frost `#88C0D0` accent
- Includes matching terminal ANSI colors (Aurora + Frost)

## Install on Windows (required)

Desktop plugins load from the **local** Windows HERMES_HOME, not the remote Linux gateway.

1. Create folder:
   ```
   %LOCALAPPDATA%\hermes\desktop-plugins\nord-theme\
   ```
2. Copy `plugin.js` into that folder.
3. In Hermes Desktop: **Ctrl+K** → **Reload desktop plugins**
4. **Settings → Appearance** → select **Nord**
5. Toggle light/dark as usual (theme ships both palettes)

Optional: Settings → Plugins should list **Nord Theme** as enabled.

## Verify

- Theme picker shows **Nord**
- Dark mode: background `#2E3440`, cyan accent `#88C0D0`
- Light mode: background `#ECEFF4`, blue accent `#5E81AC`
