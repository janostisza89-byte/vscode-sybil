# New Project Setup Checklist

Follow this top to bottom for any brand-new project. Steps marked **(once per machine)**
only need doing the first time you set up a new dev machine — skip them on every project
after that.

## 1. Register the project in Portal (once per project)

Portal's Projects admin (`http://foundry-vm.tail054086.ts.net:8000/admin`) → create the
project, assign yourself to it. This has to exist before anything below will work.

## 2. Install the Sybil extension **(once per machine)**

1. Download the latest `vscode-sybil-*.vsix` from
   [GitHub Releases](https://github.com/janostisza89-byte/vscode-sybil/releases) (or grab
   the one just built, if Sybil handed you one directly).
2. In VS Code: Extensions panel (left sidebar) → `...` menu (top right of that panel) →
   **Install from VSIX...** → pick the file.
   - If you already have an older version installed, this just upgrades it in place —
     no need to uninstall first.

## 3. Get a Portal access token (once per project, or reuse one you already have)

Portal → **My Projects** → **Sybil / Claude Code access** → **+ Generate token**, name it
(e.g. your machine's name). Copy it — you won't see it again after this screen.

## 4. Open the project folder and run Auto-Configure

1. Open the project's folder in VS Code (File → Open Folder).
2. Click the **Sybil icon** in the Activity Bar (far left) → **Setup** panel.
3. Paste **Portal URL**: `http://foundry-vm.tail054086.ts.net:8000`
4. Paste the **token** from step 3.
5. Click **Auto-Configure** → pick the project from the list.

This single click now does all of the following automatically:
- Writes `.mcp.json` (SybilKB connection) and your global `CLAUDE.md`
- Provisions your own SonarQube account/token (invisible, one-time, first project only)
- Onboards this machine onto the project's SonarQube setup (creates the project if it's
  new, or just gets this machine its own scan token if someone else already onboarded it)
- Writes `sonar-project.properties`, `.githooks/post-commit`, and a gitignored
  `.sonar-token` into the project folder

## 5. Make sure the project is a git repo

If it isn't yet: open a terminal in the project folder and run `git init`.

**If you did this git init AFTER running Auto-Configure**, the SonarQube hook wiring
above silently skipped itself (no repo existed yet to point at) — re-run Auto-Configure
now that it's a repo, or just run this once yourself:
```
git config core.hooksPath .githooks
```

## 6. Install the `sonar-scanner` CLI **(once per machine)**

Only needed for the actual code-quality scan to run — everything else above works
without it.

1. Download the Windows scanner from
   [SonarSource's SonarScanner CLI docs](https://docs.sonarsource.com/sonarqube-cli/quickstart-guide).
2. Extract the zip somewhere permanent (e.g. `C:\tools\sonar-scanner\`). If Windows
   blocked the zip, right-click it → Properties → **Unblock** before extracting.
3. Add that folder's `bin` subfolder to your PATH (Windows Settings → search "environment
   variables" → Edit the PATH variable → New → add the `...\bin` path).
4. Open a **new** terminal (PATH changes don't apply to already-open ones) and run
   `sonar-scanner.bat -h` to confirm it's found.
   - No need to edit `sonar-scanner.properties` for the server URL — the git hook already
     passes it explicitly on every run.

## 7. Make a commit

That's what actually triggers the scan — the hook fires in the background after every
commit, never blocking it. First run creates the project's first real analysis;
`http://foundry-vm.tail054086.ts.net:9000/dashboard?id=<ProjectKey>` will show real data
afterward instead of the "no analysis yet" screen.

---

### If something looks broken
- Task Board shows "not configured" right after Auto-Configure finished → click its own
  Refresh button once (should be automatic now, but if you're on an older `.vsix` this was
  a known bug, fixed in v0.0.6+).
- `.sonar-token` / `.gitignore` missing after Auto-Configure → you were on a `.vsix` older
  than v0.0.11 (a real bug, now fixed), or the project wasn't a git repo yet at the time —
  see step 5.
