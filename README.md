# Sybil for VS Code

A companion extension for [SybilKB](https://github.com/) — visual, clickable surfaces for
a SybilKB-backed project's task board, documentation, decision history, and code-quality
gates, from inside VS Code.

**This extension does not write or edit code.** It's a data/visibility layer only —
actual coding work stays with your MCP-capable coding agent (e.g. Claude Code) talking to
the same SybilKB instance over the same protocol. Think of this as the dashboard sitting
next to the agent doing the work, not a replacement for it.

## What it does today (v0.0.1)

- **Setup** — configure your SybilKB endpoint, access token, and project, test the
  connection
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

## Setup

1. In Portal, go to **My Projects** → **Sybil / Claude Code access** → generate a token.
2. In this extension's **Setup** panel, set:
   - **Endpoint URL** — your SybilKB instance's MCP endpoint (e.g.
     `http://your-host:8053/mcp`)
   - **Access Token** — the token from step 1 (stored in your OS keychain via VS Code's
     SecretStorage, never written to disk in plaintext)
   - **Project** — your Portal user ID (owner_id, shown alongside your token) and the
     project key you're working on
3. Click **Test Connection** to confirm.

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
