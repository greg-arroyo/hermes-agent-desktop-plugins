# Issue Orchestration — a GitHub Issues plugin for Hermes Desktop

Browse, search, create, edit, pin, close and delete the issues of **one GitHub repository** without leaving [Hermes Desktop](https://hermes-agent.nousresearch.com/docs). It adds an **Issue Orchestration** entry (with the Octocat icon) to the left navigation.

It is a single JavaScript file. There is no server, no account and no telemetry: the plugin talks straight from your PC to `api.github.com` with a GitHub token that **you** create and that stays on your PC.

> Unofficial community plugin. Not affiliated with or endorsed by GitHub, Inc.

## What it does

- **Open / Closed lists** in a GitHub-style box, with counter bubbles, paging (10 per page by default, 1–100 in Settings) and a **Sort** menu (Created on / Last updated, Newest / Oldest).
- **Search box** that takes GitHub's own issue-search syntax (`label:bug`, `author:name`, `in:title`, plain words …). The `is:issue state:open|closed` front is locked and follows the Open / Closed buttons. A lone `#42` shows exactly issue 42.
- **Labels menu** — pick labels from your repo's own list (several = all of them); **Clear** removes every label filter at once.
- **One form to add and edit an issue** — Title, Description (Markdown), Labels. Editing is the same form pre-filled; only the fields you changed are saved, and if someone changed the issue on GitHub meanwhile you are asked before anything is overwritten.
- **Sub-issues** — see them under their parent (to any depth), create them, close / edit them from their own row, filter open-only, and drag to reorder (the order is stored on GitHub).
- **Close as completed / not planned / duplicate** (the duplicate target is recorded on GitHub), and **reopen**.
- **Delete issue** — permanent, and it takes the issue's sub-issues with it (you must type the issue number to confirm when there are any).
- **Pinned issues** — uses GitHub's own pins (up to 3 per repository, shared with github.com). Pinned issues show as cards above the search box; clicking a card shows just that issue, expanded, and **Show all issues** puts everything back as it was.
- **Settings** — repository, token, "include sub-issues in the lists", "collapse sub-issues by default", issues per page, and an optional **docked right-side panel** (see [Docked panel](#docked-panel)).

## Requirements

- **Hermes Desktop** with desktop-plugin support. Built and tested on Windows against Hermes Agent / Desktop **v0.21.x** (October 2026 builds). Other versions or platforms are untested.
- A **GitHub account** with access to the repository you want to manage.
- A **fine-grained personal access token** (see below).

## Install

The plugin must live in a folder named **exactly** `github-issues` in Hermes Desktop's plugin folder **on the PC that runs Desktop**:

```
%LOCALAPPDATA%\hermes\desktop-plugins\github-issues\plugin.js
```

**Option A — by hand**

1. Open `%LOCALAPPDATA%\hermes\desktop-plugins\` (paste that into the File Explorer address bar). If `desktop-plugins` does not exist yet, create it.
2. Create a folder named `github-issues` inside it.
3. Copy `plugin.js` into that folder.

**Option B — the installer script**

In PowerShell, from this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-github-issues.ps1
```

**Then, in either case:** in Hermes Desktop press **Ctrl+K**, run **Reload desktop plugins**, and click **Issue Orchestration** in the left navigation.

## Create the GitHub token

Create a *fine-grained* token with the least access that works:

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Repository access:** *Only select repositories*, and pick just the repository you want to manage.
3. **Repository permissions:** **Issues → Read and write**. (Metadata → Read is added automatically.) Nothing else is needed for everyday use.
4. Set an **expiry** (30–90 days is sensible). Avoid classic tokens and never use one with the broad `repo` scope.
5. Copy the token (it starts with `github_pat_`). You see it only once.

Some actions go through GitHub's GraphQL API and need more rights on the repository itself: **deleting** an issue needs repository **admin**, and pinning / un-pinning needs enough write access (it was tested with an admin account). If GitHub refuses, the plugin shows GitHub's message and changes nothing.

## First run

1. Open **Issue Orchestration**. The setup screen asks for the repository (`https://github.com/owner/repo` or just `owner/repo`) and the token.
2. Paste both and press **Verify & save** (later edits in Settings use **Save**). The plugin checks them against GitHub first and saves nothing if GitHub rejects them.
3. To change the repository, the token or the display options later, use the **gear** icon at the top right. The **circular arrows** reload everything.

## Docked panel

By default the plugin lives in the left navigation and opens in the main area. If you would rather have it always at hand, turn on a persistent panel:

1. Open **Issue Orchestration → Settings (gear)**.
2. Under **Docked panel**, tick **Keep Issue Orchestration docked in a right-side panel** and press **Save**.

What that does:

- The panel appears immediately, and is registered again every time Hermes Desktop starts, so it is there from the moment the app opens. The option is **off by default**.
- It is the same page as the main-area view (same repository, token and display settings), with a slimmer left margin. Saving Settings in one view makes the other re-read them.
- It has no Close button. Closing a plugin's only pane would disable the whole plugin, so you remove the panel by **unticking the option and saving**. Unticking removes it at once, with no reload.
- The option is not shown on first-time setup, only once a repository and token are saved.

**Moving it.** Desktop lets you drag any panel to a different edge (left, right, top, bottom) or stack it with another one, and it remembers the layout. The drag handle is the panel's **tab**, and Desktop hides the tab strip when a zone holds a single panel. If you cannot see a handle, use any of these:

- **Settings → Appearance → Tab Strip → Always** (recommended);
- **Ctrl+Alt+T** (*Toggle tabs*), or right-click the panel's zone and choose **Show tabs**;
- stack another panel (Files, Review) into the same zone so the strip appears.

The plugin only chooses the *first* placement (right-hand side, 420 px wide); after that the position is yours, and Desktop's **Reset layout** returns everything to the defaults. Where the panel was last placed, and whether it survives a restart, is handled by Desktop's own layout storage, not by this plugin.

## Security and privacy — please read

- The token is saved **in plaintext in Hermes Desktop's local plugin storage on your PC**. It is not encrypted. Anyone who can use your Windows profile, and any other Desktop plugin you enable, could read it. Only run plugins you trust (and read this one — it is one file).
- It is sent **only to `https://api.github.com`**, over HTTPS, with each request. It is never sent to the Hermes host, an agent, or anywhere else. The plugin makes no other network requests and has no analytics. (Clicking an issue's link icon, or a link inside a description, opens that address in your normal browser — that is your click, not the plugin phoning anywhere.)
- **Remove saved token** (in Settings) clears the token from your PC but does **not** revoke it. If a PC is lost or a token may have leaked, revoke it at <https://github.com/settings/personal-access-tokens>.
- Do not paste the token into chats, issues or screenshots.
- Everything you see (issues, labels, pins) is read live from GitHub; the plugin stores only the repository name, the token and your display settings (including whether the docked panel is on).

## Using it

| To … | Do this |
|---|---|
| Read an issue | Click its row — the description and sub-issues expand in place. |
| Create an issue | **New issue** (next to the search box). Title is required. **Ctrl+Enter** saves. |
| Edit an issue | Row's **⋯ → Edit**. Update is enabled once something changed. |
| Add a sub-issue | Expand the parent, then **Create sub-issue**. |
| Reorder sub-issues | Drag the grip that appears on hover, or focus it and use ↑ / ↓. |
| Filter | Type in the search box and press Enter or click the magnifier; or use **Labels ▾**. |
| Pin an issue | Row's **⋯ → Pin issue** (3 at most). **⋯ → Un-pin** on its card removes it. |
| Show only one issue | Click a pinned card, or type `#42` in the search box. **Show all issues** goes back. |
| Close / reopen | Row's **⋯**. Closing as *duplicate* asks which issue it duplicates. |
| Delete | Row's **⋯ → Delete issue…** — permanent, includes sub-issues. |

## Limits

- One repository at a time (change it in Settings).
- GitHub allows **30 search requests per minute** and returns at most the **first 1000** results of a search. Each search, label click or page change costs a few of those requests; if you hit the limit the counters keep their last values and GitHub's message is shown.
- Sub-issues are a GitHub feature (up to 8 levels deep) and must be available for your repository.
- Pull requests are not shown — only issues.

## Troubleshooting

| Symptom | What to check |
|---|---|
| **Issue Orchestration** is missing from the left nav | The folder must be named exactly `github-issues` and contain `plugin.js` directly. Then **Ctrl+K → Reload desktop plugins**. |
| "GitHub rejected the token (401)" | The token is expired, revoked or mistyped. Open Settings and paste a new one. |
| "Not found (404)" | The repository name is wrong, or the token was not given access to that repository when it was created. |
| "The token lacks permission for this action (403)" | The token needs **Issues: Read and write** on that repository (and admin rights to delete). |
| "GitHub rate limit reached" | Wait a few minutes (search is limited to 30 requests a minute). |
| Pinning, un-pinning or deleting is refused | GitHub decided you lack rights on that repository; the message says why. |
| A blank page after an update | Press **Ctrl+K → Reload desktop plugins**. |
| The docked panel is on but I do not see it | It stacks with the other right-hand panels (Files, Review) on first appearance. Open or expand the right-hand zone, or use **Reset layout**. |
| The docked panel has no drag handle | Desktop hides the tab strip for a lone panel. Set **Settings → Appearance → Tab Strip → Always**, or press **Ctrl+Alt+T**. |
| I cannot close the docked panel | By design. Untick the option under **Settings → Docked panel** and Save. |

## Verify your download

`plugin.js.sha256` holds the SHA-256 of `plugin.js`. In PowerShell:

```powershell
(Get-FileHash .\plugin.js -Algorithm SHA256).Hash.ToLower()
```

The result must equal the value in `plugin.js.sha256`.

## Uninstall

1. In the plugin, open Settings, untick **Docked panel** if it is on (then Save), and click **Remove saved token** (so no token stays in the app's storage).
2. Delete the `github-issues` folder from `%LOCALAPPDATA%\hermes\desktop-plugins\`.
3. **Ctrl+K → Reload desktop plugins**.
4. Revoke the token on GitHub if you no longer need it.

## Credits

Most icons are adapted from GitHub's [Octicons](https://github.com/primer/octicons) (MIT License, © GitHub, Inc.); the gear, pin and sort icons are original geometry. "GitHub" and the Octocat are trademarks of GitHub, Inc., used here only to show what the plugin connects to.
