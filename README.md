# Sybil for VS Code

A companion extension for [SybilKB](https://github.com/) — visual, clickable surfaces for
a SybilKB-backed project's task board, documentation, decision history, and code-quality
gates, from inside VS Code.

**This extension does not write or edit code.** It's a data/visibility layer only —
actual coding work stays with your MCP-capable coding agent (e.g. Claude Code) talking to
the same SybilKB instance over the same protocol. Think of this as the dashboard sitting
next to the agent doing the work, not a replacement for it.

## What it does today (v0.0.2)

- **Setup** — one-step auto-configure from a Portal URL + token (see below), or manual
  per-field entry for a Portal-less SybilKB deployment
- **Task Board** — view open tasks (`sybil_task_list`), open new ones (`sybil_task_open`)

## Roadmap (built incrementally, not all at once)

- Module Browser (`sybil_search` / `sybil_get_module`)
- DCP Recall (`sybil_recall`)
- Quality Gate (`sybil_get_quality_report`) — only shown for projects with one configured
- Task closing as a real form (currently list/create only — closing needs
  `resolution_summary` / `files_changed` / `validation_result`, deferred to keep this
  first cut honest about scope)
- Richer webview UI (current views are plain HTML/JS; a proper bundled UI layer is a
  later pass once the shell itself is proven out)
- Optional third-party MCP server recommendations (e.g. Playwright MCP) — one-time
  prompt, no coupling to this extension's own internals
- A local component for AST/code-relation extraction on projects whose source never
  leaves the developer's machine (parallel effort, tracked separately — not blocking
  this extension's own progress)

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
