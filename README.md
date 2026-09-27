# Sybil for VS Code

A companion extension for [SybilKB](https://github.com/) — visual, clickable surfaces for
a SybilKB-backed project's task board, documentation, decision history, and code-quality
gates, from inside VS Code.

**This extension does not write or edit code.** It's a data/visibility layer only —
actual coding work stays with your MCP-capable coding agent (e.g. Claude Code) talking to
the same SybilKB instance over the same protocol. Think of this as the dashboard sitting
next to the agent doing the work, not a replacement for it.

## What it does today (v0.0.5)

- **Setup** — one-step auto-configure from a Portal URL + token (see below), or manual
  per-field entry for a Portal-less SybilKB deployment
- **Task Board** — view tasks (`sybil_task_list`, filterable by status), open new ones with a
  priority (`sybil_task_open`), click into one for full detail (`sybil_task_get`). From there:
  edit description/priority (`sybil_task_update`), a quick priority-only change, mark it
  Complete (`sybil_task_close`) or Obsolete (`sybil_task_obsolete`, distinct from Complete —
  "doesn't need doing" vs "got done"), or Reactivate a closed one back to Open
  (`sybil_task_reactivate`) — parity with what Portal's Control Room UI already does directly
  against ZeigarnikClerk, added to SybilKB's own tool surface 2026-09-26. Search box filters
  the currently loaded list client-side — there's no server-side task search tool yet, so it
  only covers what's already fetched under the current status filter, not the whole board.
- **Automatic SonarQube onboarding** — the moment a project is selected (auto-configure or
  the manual Set Project ID button), invisibly: SybilKB ensures this user has their own
  SonarQube account/token (auto-provisioned on first use, never surfaced in this UI — that
  credential lives server-side in Portal, this extension never sees it), then onboards
  this machine onto the project's SonarQube setup — creating the project if it doesn't
  exist yet (check-before-create, never touches an already-existing one) or just minting
  this machine its own fresh scan token if it does. Locally writes
  `sonar-project.properties` + `.githooks/post-commit` (only if neither already exists,
  never clobbers hand-customized scanner config) and a gitignored `.sonar-token`, then
  points git at the hooks directory.
- **Quality Gate** — gate status (OK/ERROR badge), each failing/passing condition
  (`sybil_get_quality_report`), and open issues by severity. A project with no SonarQube
  counterpart yet shows a plain "not configured" message inline rather than an error or
  a hidden view — that's the expected state for most projects until onboarding + a real
  scan has happened.
- **Docs Search** — a query box over CAGI's documentation (`sybil_search`), and a
  module-name box for a direct lookup (`sybil_get_module`). Pull-based like everything
  above: type a query, get a result, nothing goes stale on its own since there's no
  ambient status being displayed. Clicking a result's source card feeds a best-effort
  guess at that doc's module name into the lookup box.
- **Project setup: Add Playwright MCP** — one click merges a working `playwright` entry
  (headless chromium via `@playwright/mcp`) into the workspace's `.mcp.json`, no manual
  editing. First of a growing set of one-time, template-driven per-project setup steps
  (see Roadmap) — carries no secret, so it's always safe to merge, unlike the `sybil-kb`
  entry's token-leak guarding.

## Roadmap (built incrementally, not all at once)

- DCP Recall (`sybil_recall`)
- Richer webview UI (current views are plain HTML/JS; a proper bundled UI layer is a
  later pass once the shell itself is proven out)
- A customer-docs site scaffold (Starlight) — same "one-time, template-driven, local
  repo change" shape as the SonarQube/Playwright project-setup steps, next in line
- A local component for AST/code-relation extraction on projects whose source never
  leaves the developer's machine (parallel effort, tracked separately, heavier lift than
  the project-setup steps above — an always-running local process, not a one-time copy)

## Setting up a new project

**→ See [NEW_PROJECT_SETUP.md](NEW_PROJECT_SETUP.md) for the full, copy-pasteable checklist**
(install → auto-configure → git init → sonar-scanner CLI → first commit). This section and
the ones below are reference material for how the extension works, not a step-by-step guide.

## Installation

Not yet on the VS Code Marketplace — install from a [GitHub Release](https://github.com/janostisza89-byte/vscode-sybil/releases) `.vsix` in the meantime:

1. Download the latest `vscode-sybil-*.vsix` from [Releases](https://github.com/janostisza89-byte/vscode-sybil/releases).
2. In VS Code: Extensions panel → `...` menu (top right) → **Install from VSIX...** → select the downloaded file.
   Or from a terminal: `code --install-extension vscode-sybil-<version>.vsix`
3. Click the Sybil icon in the Activity Bar, open **Setup**, and follow the flow below.

## Setup

Every user needs a Portal login (2FA-protected) regardless of how they'll actually
connect — token minting always requires a real session, by design, so this first step
can't be automated away and isn't meant to be.

1. Log into Portal, go to **My Projects** → **Sybil / Claude Code access** →
   **+ Generate token**, name it (e.g. your machine's name).
2. In this extension's **Setup** panel, paste your **Portal URL** (e.g.
   `http://your-portal-host:8000`) and the **token** from step 1, then click
   **Auto-Configure**. This will:
   - Fetch your identity and project assignments, and let you pick which project this
     workspace works on
   - Fetch SybilKB's actual endpoint (no need to know or type it)
   - Write `.mcp.json` into the current workspace root (merged with any existing MCP
     servers already configured there — never wholesale overwritten), with your real
     token embedded so Claude Code (or any other MCP-compatible tool — same file, same
     protocol, no separate integration needed) works immediately
   - Fetch and write your personalized `CLAUDE.md` to `~/.claude/CLAUDE.md` — prompts
     before overwriting if one already exists, since that file is often hand-edited
3. Click **Test Connection** to confirm.

If you're not using Claude Code (or another `.mcp.json`-reading tool), the token +
endpoint alone are enough — the two files above are only needed for tools that read
`.mcp.json`/`CLAUDE.md` specifically.

**Requires a Foundry Portal build from 2026-09-17 or later** — this flow depends on
Portal's `sybil-info`/`sybil-claude-md`/`sybil-mcp-json` endpoints accepting bearer-token
auth (`Portal/routers/profile.py`, `_current_user_id_or_bearer`), not just a browser
session cookie. An older Portal will reject the auto-configure calls with 401s; fall back
to manual setup (advanced section) in that case.

## Security model

This extension has no embedded credentials, no hardcoded server address, and no
Foundry-specific (or any other project's) logic — it's a generic SybilKB MCP client,
same protocol and auth Claude Code already uses. The actual access control lives
server-side: every call is bearer-token-authenticated and validated against your
SybilKB instance's own project-membership rules, fail-closed. Being open source doesn't
widen your attack surface — the server enforces the boundary either way.

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Then in VS Code: `F5` to launch an Extension Development Host with this extension loaded.

## License

MIT
