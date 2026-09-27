import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { McpJsonResponse } from "./portalClient";
import { SybilMcpClient } from "./mcpClient";
import { SybilConfig } from "./config";
import { getWorkspaceId, backfillRepo } from "./cartographerPush";

const execFileAsync = promisify(execFile);

function looksLikeEnvPlaceholder(value: unknown): boolean {
  return typeof value === "string" && /\$\{[A-Z_][A-Z0-9_]*\}/.test(value);
}

async function isGitTracked(filePath: string, cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["ls-files", "--error-unmatch", filePath], { cwd });
    return true;
  } catch {
    return false;
  }
}

async function isInsideGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure .gitignore (creating it if absent) covers the given entry, inside a
 * git repo only — nothing to protect from committing if there's no repo yet.
 * Best-effort: called right after writeMcpJson embeds a raw token, so a fresh
 * project never depends on Janos remembering to gitignore .mcp.json himself
 * (2026-09-26 correction — the previous behavior only warned when the file
 * was ALREADY tracked, which does nothing for a brand-new file about to be
 * committed for the first time).
 */
async function ensureGitignored(cwd: string, entry: string): Promise<"added" | "already_present" | "skipped_no_git"> {
  if (!(await isInsideGitRepo(cwd))) {
    return "skipped_no_git";
  }
  const gitignorePath = path.join(cwd, ".gitignore");
  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf-8");
  } catch {
    // No .gitignore yet — appendFile below creates it.
  }
  if (content.split(/\r?\n/).some((l) => l.trim() === entry)) {
    return "already_present";
  }
  const needsLeadingNewline = content.length > 0 && !content.endsWith("\n");
  await fs.appendFile(gitignorePath, `${needsLeadingNewline ? "\n" : ""}${entry}\n`, "utf-8");
  return "added";
}

/**
 * Ensure .gitattributes (creating it if absent) covers the given line —
 * same idempotent create-or-append shape as ensureGitignored. Added after a
 * real onboarding session (Cats, 2026-09-27) hit CRLF/LF warnings on every
 * commit, and flagged the sharper real risk: a hook file checked out with
 * CRLF line endings (Windows default without this) breaks its own
 * `#!/usr/bin/env bash` shebang on a teammate's first Linux/macOS checkout.
 * Called from both SonarQube's and Cartographer's setup — either one may
 * run first, and the line only needs to exist once regardless of which.
 */
async function ensureGitattributesLine(cwd: string, line: string): Promise<"added" | "already_present" | "skipped_no_git"> {
  if (!(await isInsideGitRepo(cwd))) {
    return "skipped_no_git";
  }
  const gitattributesPath = path.join(cwd, ".gitattributes");
  let content = "";
  try {
    content = await fs.readFile(gitattributesPath, "utf-8");
  } catch {
    // No .gitattributes yet — appendFile below creates it.
  }
  if (content.split(/\r?\n/).some((l) => l.trim() === line)) {
    return "already_present";
  }
  const needsLeadingNewline = content.length > 0 && !content.endsWith("\n");
  await fs.appendFile(gitattributesPath, `${needsLeadingNewline ? "\n" : ""}${line}\n`, "utf-8");
  return "added";
}

/**
 * Write/merge .mcp.json into the current workspace root. Merges rather than
 * overwrites — a real dev environment likely has other MCP servers already
 * configured, and this must not clobber them.
 *
 * Never silently embeds a raw token into a git-tracked .mcp.json. Confirmed
 * live (2026-09-17): a Foundry_v2 test run overwrote that repo's own
 * committed .mcp.json — which deliberately uses ${SYBILKB_TOKEN}/
 * ${SYBILKB_MCP_URL} placeholders so it's safe to commit — with a real
 * bearer token, one `git add`/`commit` away from leaking it into history.
 * Two guards now: (1) if the existing sybil-kb entry already uses
 * ${...}-style placeholders, leave it untouched entirely — that pattern is
 * a deliberate signal the project wants env-var indirection, not a raw
 * secret; (2) otherwise, if the file is git-tracked (or would be newly
 * created inside a git repo), warn before writing a raw token, same
 * modal-confirm pattern as the CLAUDE.md write below.
 */
export interface WriteMcpJsonResult {
  path: string;
  gitignore: "added" | "already_present" | "skipped_no_git";
}

export async function writeMcpJson(mcpJson: McpJsonResponse, token: string): Promise<WriteMcpJsonResult> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("No workspace folder open — open a folder before running auto-configure.");
  }
  const cwd = folder.uri.fsPath;
  const filePath = path.join(cwd, ".mcp.json");

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    // No existing file, or it's not valid JSON — start fresh either way;
    // an invalid existing file would have been broken for Claude Code too.
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {};
  const existingEntry = mcpServers["sybil-kb"] as { url?: unknown; headers?: { Authorization?: unknown } } | undefined;

  if (looksLikeEnvPlaceholder(existingEntry?.url) || looksLikeEnvPlaceholder(existingEntry?.headers?.Authorization)) {
    throw new Error(
      `${filePath} already has a sybil-kb entry using \${...} env-var placeholders — left untouched, since that's a deliberate signal this project wants env-var indirection, not an embedded secret. Set SYBILKB_TOKEN/SYBILKB_MCP_URL in your shell environment instead.`
    );
  }

  const tracked = (await isInsideGitRepo(cwd)) && (await isGitTracked(".mcp.json", cwd));
  if (tracked) {
    const choice = await vscode.window.showWarningMessage(
      `${filePath} is tracked by git. Writing your real token into it risks committing a live credential into history.`,
      { modal: true },
      "Write anyway",
      "Cancel"
    );
    if (choice !== "Write anyway") {
      throw new Error("Cancelled — .mcp.json is git-tracked, left untouched.");
    }
  }

  mcpServers["sybil-kb"] = {
    type: mcpJson.mcpServers["sybil-kb"].type,
    url: mcpJson.mcpServers["sybil-kb"].url,
    headers: { Authorization: `Bearer ${token}` },
  };
  existing.mcpServers = mcpServers;

  await fs.writeFile(filePath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  const gitignore = await ensureGitignored(cwd, ".mcp.json");
  return { path: filePath, gitignore };
}

/**
 * Merge a recommended Playwright MCP entry into .mcp.json — the standard
 * config Janos hand-installed for Foundry-v4 (2026-09), confirmed working:
 * @playwright/mcp via npx, headless chromium. Unlike writeMcpJson's sybil-kb
 * entry, this carries no secret/token, so none of that function's git-tracked
 * placeholder/warning logic applies — safe to merge in unconditionally.
 * No-ops if a "playwright" entry already exists, successful or not: this is
 * an additive recommendation, never a silent overwrite of whatever the repo
 * already has configured for that key.
 */
export async function addPlaywrightMcp(): Promise<"added" | "already_present"> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("No workspace folder open — open a folder before running this.");
  }
  const cwd = folder.uri.fsPath;
  const filePath = path.join(cwd, ".mcp.json");

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    // No existing file, or invalid JSON — start fresh either way.
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {};
  if (mcpServers["playwright"]) {
    return "already_present";
  }

  mcpServers["playwright"] = {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless", "--browser", "chromium"],
  };
  existing.mcpServers = mcpServers;

  await fs.writeFile(filePath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  return "added";
}

/**
 * A post-commit hook section, not a whole hook file — see ensureHookSection.
 * Fires a background sonar-scanner run after every commit, reporting to the
 * centrally-hosted SonarQube CE server. Never blocks the commit, never runs
 * inside a Claude Code / Sybil session -- this is a plain git hook, same
 * mechanism as any linter pre-commit hook.
 *
 * Token resolution: env var SONAR_TOKEN, else a gitignored .sonar-token file
 * at repo root. Neither is ever committed. Assumes $REPO_ROOT is already set
 * by the shared header ensureHookSection writes once per file.
 *
 * Three Windows/git-bash fixes folded in after a real onboarding session
 * (Cats project, 2026-09-27) hit all three live:
 * - `command -v sonar-scanner` never matches on git-bash (MSYS) when only
 *   sonar-scanner.bat is on PATH — bash's `command -v` doesn't do Windows'
 *   PATHEXT resolution the way cmd.exe does. Now probes .bat/.cmd too.
 * - The scanner's default JRE auto-provisioning throws AccessDeniedException
 *   on a fresh Windows extraction (AV/indexer lock) — harmless to always
 *   skip since NEW_PROJECT_SETUP.md's own install instructions already use
 *   the JRE-bundled CLI zip.
 * - Repo inside a OneDrive/Dropbox/iCloud-synced folder: the sync client's
 *   own lock collides with the scanner deleting/recreating its working
 *   directory (.scannerwork/.sonartmp) — 100% reproducible, not flaky.
 *   Redirected to a per-repo folder under %LOCALAPPDATA%, Windows-only.
 */
const SONARQUBE_POST_COMMIT_SECTION = `SONAR_HOST_URL="\${SONAR_HOST_URL:-__SONAR_HOST_URL__}"

if [ -z "\${SONAR_TOKEN:-}" ] && [ -f "$REPO_ROOT/.sonar-token" ]; then
    SONAR_TOKEN="$(cat "$REPO_ROOT/.sonar-token")"
fi

SONAR_SCANNER_BIN=""
for _candidate in sonar-scanner sonar-scanner.bat sonar-scanner.cmd; do
    if command -v "$_candidate" >/dev/null 2>&1; then
        SONAR_SCANNER_BIN="$_candidate"
        break
    fi
done

SONAR_EXTRA_OPTS="-Dsonar.scanner.skipJreProvisioning=true"
case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*)
        if [ -n "\${LOCALAPPDATA:-}" ]; then
            _repo_hash="$(echo "$REPO_ROOT" | cksum | cut -d' ' -f1)"
            SONAR_EXTRA_OPTS="$SONAR_EXTRA_OPTS -Dsonar.working.directory=$LOCALAPPDATA/sonar-scanner-work/$_repo_hash"
        fi
        ;;
esac

if [ -z "\${SONAR_TOKEN:-}" ]; then
    echo "[post-commit] SONAR_TOKEN not set (env or .sonar-token) -- skipping scan." >&2
elif [ -z "$SONAR_SCANNER_BIN" ]; then
    echo "[post-commit] sonar-scanner not installed -- skipping scan." >&2
else
    (
        cd "$REPO_ROOT" && \\
        "$SONAR_SCANNER_BIN" -Dsonar.host.url="$SONAR_HOST_URL" -Dsonar.token="$SONAR_TOKEN" $SONAR_EXTRA_OPTS \\
            >> "$REPO_ROOT/.sonar-scan.log" 2>&1
    ) &
    disown
fi`;

/**
 * Cartographer Redesign (task 1b356f70) -- pushes a branch-tagged code-graph
 * delta for every changed file after each commit, for projects whose source
 * lives only on this machine, not the Foundry VM. `install_dir` in the
 * gitignored .sybil-cartographer.json points at this machine's one-time
 * global install of the actual push script + wasm grammars (see
 * setupCartographerFiles) -- never committed, since that install is
 * machine-specific and the wasm binaries shouldn't bloat every consuming
 * repo's git history. Silently no-ops if either is missing (a machine that
 * never ran Sybil's onboarding, or a repo predating this feature).
 */
const CARTOGRAPHER_POST_COMMIT_SECTION = `CARTOGRAPHER_CONFIG="$REPO_ROOT/.sybil-cartographer.json"

if [ -f "$CARTOGRAPHER_CONFIG" ] && command -v node >/dev/null 2>&1; then
    CARTOGRAPHER_INSTALL_DIR="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).install_dir||'')}catch(e){}" "$CARTOGRAPHER_CONFIG")"
    if [ -n "$CARTOGRAPHER_INSTALL_DIR" ] && [ -f "$CARTOGRAPHER_INSTALL_DIR/cartographer-hook-push.js" ]; then
        (
            cd "$REPO_ROOT" && \\
            node "$CARTOGRAPHER_INSTALL_DIR/cartographer-hook-push.js" \\
                >> "$REPO_ROOT/.cartographer-push.log" 2>&1
        ) &
        disown
    fi
fi`;

const HOOK_FILE_HEADER = `#!/usr/bin/env bash
# Versioned under .githooks/ (not .git/hooks/) so it ships with the repo on
# any future checkout -- see \`git config core.hooksPath .githooks\`. Each
# section below is added independently by whichever Sybil feature needs a
# post-commit trigger (see ensureHookSection) -- every section checks for its
# own marker before writing, so re-running any one feature's setup never
# duplicates a block or clobbers another feature's section.
set -uo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
`;

/**
 * Idempotently ensures ONE named section exists inside the shared
 * .githooks/post-commit file -- creates the file (with the shared header)
 * if it doesn't exist yet, appends this section if the file exists but
 * lacks it, or does nothing if the marker (or `legacySignature`) is already
 * present. This is what lets SonarQube's and Cartographer's post-commit
 * triggers coexist in one file regardless of which one's onboarding ran
 * first -- git only supports one post-commit file per hooksPath, there's no
 * "install two hooks".
 *
 * `legacySignature`: a distinctive substring from a PRE-marker version of
 * this section's own template, if one ever shipped without the marker
 * wrapper this function now relies on. Without this, a hook file written by
 * an older version of Sybil (SonarQube's original template had no marker at
 * all) is invisible to the `includes(marker)` check, so re-running that
 * feature's onboarding appends a second, marked copy on top of the
 * unmarked original -- confirmed live, 2026-09-27, against a real project's
 * hook file predating this scheme: SonarQube's block got duplicated,
 * meaning sonar-scanner would have run twice per commit. Cartographer has
 * no legacy format (it shipped with markers from day one), so its own call
 * site omits this parameter.
 */
async function ensureHookSection(
  cwd: string,
  markerId: string,
  section: string,
  legacySignature?: string
): Promise<"created" | "appended" | "already_present"> {
  const hooksDir = path.join(cwd, ".githooks");
  const hookPath = path.join(hooksDir, "post-commit");
  const marker = `# --- sybil:${markerId} ---`;

  let existing: string | undefined;
  try {
    existing = await fs.readFile(hookPath, "utf-8");
  } catch {
    existing = undefined;
  }

  if (existing !== undefined) {
    if (existing.includes(marker) || (legacySignature && existing.includes(legacySignature))) {
      return "already_present";
    }
    // Strip a trailing bare `exit <n>` line before appending — SonarQube's
    // original (pre-marker) template ended with exactly that, and appending
    // after it would silently make everything past it dead code (bash stops
    // at exit). Confirmed live, 2026-09-27, against a real project's hook
    // file. No section needs an explicit exit of its own; bash exits 0 at
    // EOF by default, which every section here is fine with.
    const trimmed = existing.replace(/\n[ \t]*exit\s+\d+[ \t]*\n?\s*$/, "\n");
    await fs.writeFile(hookPath, `${trimmed}\n${marker}\n${section}\n`, "utf-8");
    await fs.chmod(hookPath, 0o755);
    return "appended";
  }

  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(hookPath, `${HOOK_FILE_HEADER}\n${marker}\n${section}\n`, "utf-8");
  await fs.chmod(hookPath, 0o755);
  return "created";
}

function sonarProjectProperties(projectKey: string): string {
  return `# SonarQube scanner config for ${projectKey}. Analysis is triggered by
# .githooks/post-commit, not by a live Sybil session.
sonar.projectKey=${projectKey}
sonar.projectName=${projectKey}
sonar.sources=.
sonar.exclusions=**/__pycache__/**,**/.venv/**,**/venv/**,**/node_modules/**,**/dist/**,**/build/**,**/*.db,**/*.sqlite3
sonar.sourceEncoding=UTF-8
`;
}

export interface SonarQubeSetupResult {
  status: "written" | "skipped_exists" | "no_workspace";
  files?: string[];
}

/**
 * Writes the local half of SonarQube onboarding, once SybilKB's
 * sybil_sonarqube_onboard_project tool has already created/confirmed the
 * project and returned a fresh analysis token: sonar-project.properties
 * (only if it doesn't exist yet, to never clobber hand-customized scanner
 * config) + this feature's own section in the shared .githooks/post-commit
 * (see ensureHookSection — added idempotently, coexists with any other
 * feature's section already there), always refreshes .sonar-token (that
 * file's whole purpose is holding the CURRENT token), gitignores both the
 * token and the scan log, and points git at the hooks directory.
 */
export async function setupSonarQubeFiles(
  projectKey: string,
  sonarqubeUrl: string,
  analysisToken: string
): Promise<SonarQubeSetupResult> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return { status: "no_workspace" };
  }
  const cwd = folder.uri.fsPath;
  const written: string[] = [];

  const propertiesPath = path.join(cwd, "sonar-project.properties");
  const hookPath = path.join(cwd, ".githooks", "post-commit");

  const propertiesExists = await fs
    .access(propertiesPath)
    .then(() => true)
    .catch(() => false);
  if (!propertiesExists) {
    await fs.writeFile(propertiesPath, sonarProjectProperties(projectKey), "utf-8");
    written.push(propertiesPath);
  }

  const section = SONARQUBE_POST_COMMIT_SECTION.replace("__SONAR_HOST_URL__", sonarqubeUrl);
  const hookResult = await ensureHookSection(cwd, "sonarqube", section, "sonar-scanner -Dsonar.host.url");
  if (hookResult !== "already_present") {
    written.push(hookPath);
  }

  // .sonar-token and gitignoring happen BEFORE the git config call below --
  // confirmed live (2026-09-26): a workspace that isn't a git repo yet made
  // that call throw, silently aborting everything after it (the token file
  // and gitignoring never ran, only properties+hook did, since they're
  // written earlier). Nothing past this point should be able to take those
  // two down with it.
  const tokenPath = path.join(cwd, ".sonar-token");
  await fs.writeFile(tokenPath, analysisToken, "utf-8");
  written.push(tokenPath);

  await ensureGitignored(cwd, ".sonar-token");
  await ensureGitignored(cwd, ".sonar-scan.log");
  await ensureGitattributesLine(cwd, ".githooks/* text eol=lf");

  // Idempotent and cheap either way, so always run it rather than gating on
  // whether the hook file was already there — a hook file created by some
  // OTHER feature's setup (e.g. Cartographer's) still needs this pointed at.
  try {
    await execFileAsync("git", ["config", "core.hooksPath", ".githooks"], { cwd });
  } catch (err) {
    console.error("Sybil: git config core.hooksPath failed (non-fatal — not a git repo yet, or git not on PATH):", err);
  }

  return { status: written.length > 0 ? "written" : "skipped_exists", files: written };
}

async function runSonarQubeOnboarding(mcp: SybilMcpClient): Promise<void> {
  try {
    const result = (await mcp.callTool("sybil_sonarqube_onboard_project")) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const textBlock = result.content?.find((c) => c.type === "text")?.text;
    if (!textBlock) {
      console.error("Sybil: sybil_sonarqube_onboard_project returned no content");
      return;
    }
    const parsed = JSON.parse(textBlock) as {
      status?: string;
      project_key?: string;
      analysis_token?: string;
      sonarqube_url?: string;
      reason?: string;
    };
    if (parsed.status === "failed") {
      console.error("Sybil: sybil_sonarqube_onboard_project failed (non-fatal):", parsed.reason);
      return;
    }
    if (!parsed.project_key || !parsed.analysis_token || !parsed.sonarqube_url) {
      console.error("Sybil: sybil_sonarqube_onboard_project returned an incomplete result:", parsed);
      return;
    }
    const fileResult = await setupSonarQubeFiles(parsed.project_key, parsed.sonarqube_url, parsed.analysis_token);
    console.log(`Sybil: SonarQube local setup ${fileResult.status}`, fileResult.files);
  } catch (err) {
    console.error("Sybil: onboardSonarQubeProject failed (non-fatal):", err);
  }
}

/**
 * Fire-and-forget: call sybil_sonarqube_onboard_project, then write the
 * local half if it succeeds. Invisible by design (2026-09-26, Janos: "this
 * could be totally invisible for the user") -- called right after project
 * selection, same as ensureSonarqubeIdentity. Failures are logged, never
 * surfaced, since nothing in this UI currently depends on it existing yet.
 */
export function onboardSonarQubeProject(mcp: SybilMcpClient): void {
  void runSonarQubeOnboarding(mcp);
}

export interface CartographerSetupResult {
  status: "written" | "no_workspace";
  files?: string[];
}

const CARTOGRAPHER_HOOK_ASSETS = [
  "cartographer-hook-push.js",
  "tree-sitter.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
];

/**
 * Writes the local half of Cartographer's push-on-commit setup: a one-time
 * per-machine copy of the push script + wasm grammars into this extension's
 * own globalStorage (never committed -- see CARTOGRAPHER_POST_COMMIT_SECTION
 * for why), a gitignored .sybil-cartographer.json holding what a headless
 * git-hook script needs to reach SybilKB (a hook has no access to this
 * extension's VS Code storage), and the shared post-commit hook's
 * Cartographer section. Re-copies the global install every call rather than
 * checking staleness -- cheap, and keeps it current with whatever extension
 * version is actually installed.
 */
export async function setupCartographerFiles(config: SybilConfig, context: vscode.ExtensionContext, mcp: SybilMcpClient): Promise<CartographerSetupResult> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return { status: "no_workspace" };
  }
  const cwd = folder.uri.fsPath;
  const written: string[] = [];

  const installDir = path.join(context.globalStorageUri.fsPath, "cartographer-push");
  await fs.mkdir(installDir, { recursive: true });
  const sourceDir = path.join(context.extensionUri.fsPath, "dist");
  for (const file of CARTOGRAPHER_HOOK_ASSETS) {
    await fs.copyFile(path.join(sourceDir, file), path.join(installDir, file));
  }

  const [endpoint, token, projectId, ownerId] = await Promise.all([
    Promise.resolve(config.getEndpoint()),
    config.getToken(),
    Promise.resolve(config.getProjectId()),
    Promise.resolve(config.getOwnerId()),
  ]);
  if (!endpoint || !token || !projectId || !ownerId) {
    console.error("Sybil: setupCartographerFiles skipped — Sybil isn't fully configured yet.");
    return { status: "written", files: written };
  }

  const configPath = path.join(cwd, ".sybil-cartographer.json");
  const cartographerConfig = {
    endpoint,
    token,
    project_id: projectId,
    owner_id: ownerId,
    workspace_id: getWorkspaceId(context),
    install_dir: installDir,
  };
  await fs.writeFile(configPath, JSON.stringify(cartographerConfig, null, 2), "utf-8");
  written.push(configPath);
  await ensureGitignored(cwd, ".sybil-cartographer.json");
  await ensureGitignored(cwd, ".cartographer-push.log");
  await ensureGitattributesLine(cwd, ".githooks/* text eol=lf");

  const hookPath = path.join(cwd, ".githooks", "post-commit");
  const hookResult = await ensureHookSection(cwd, "cartographer", CARTOGRAPHER_POST_COMMIT_SECTION);
  if (hookResult !== "already_present") {
    written.push(hookPath);
  }

  try {
    await execFileAsync("git", ["config", "core.hooksPath", ".githooks"], { cwd });
  } catch (err) {
    console.error("Sybil: git config core.hooksPath failed (non-fatal — not a git repo yet, or git not on PATH):", err);
  }

  // One-time full-repo scan so onboarding doesn't leave everything committed
  // BEFORE this point permanently uncaptured — see backfillRepo's own
  // docstring for why this exists (found live, Cats, 2026-09-27: 9+ prior
  // commits never indexed, since the hook only sees future commits).
  try {
    const backfillResult = await backfillRepo(context, mcp, cwd);
    // A real notification, not console.log — that only lands in the
    // Extension Host output channel, easy to miss (Janos asked "where is
    // that log?" after this was console.log-only, 2026-09-27).
    if (backfillResult.status === "ok") {
      vscode.window.showInformationMessage(
        `Sybil: Cartographer backfill pushed ${backfillResult.pushed}/${backfillResult.fileCount} file(s) for this project's existing history.`
      );
    }
  } catch (err) {
    console.error("Sybil: Cartographer backfill failed (non-fatal):", err);
  }

  return { status: "written", files: written };
}

/**
 * Fire-and-forget: SonarQube onboarding, then Cartographer's local setup, in
 * that sequence -- both write into the same shared .githooks/post-commit
 * file (see ensureHookSection). Sequenced deliberately, not just for style:
 * running them concurrently as two independent fire-and-forget calls could
 * race on creating that file for the first time (both see "doesn't exist
 * yet" and each write only their own section, one clobbering the other).
 */
export function onboardProjectIntegrations(mcp: SybilMcpClient, config: SybilConfig, context: vscode.ExtensionContext): void {
  void (async () => {
    await runSonarQubeOnboarding(mcp);
    try {
      const result = await setupCartographerFiles(config, context, mcp);
      console.log(`Sybil: Cartographer local setup ${result.status}`, result.files);
    } catch (err) {
      console.error("Sybil: setupCartographerFiles failed (non-fatal):", err);
    }
  })();
}

/**
 * Write CLAUDE.md to the global ~/.claude/ location. Never silently
 * overwrites existing content — that file is often hand-edited with real
 * project-specific rules (see Foundry_v2/CLAUDE.md for what that can grow
 * into), so a stale extension write could destroy real work.
 */
export async function writeGlobalClaudeMd(content: string): Promise<"written" | "skipped"> {
  const claudeDir = path.join(os.homedir(), ".claude");
  const filePath = path.join(claudeDir, "CLAUDE.md");

  let alreadyExists = false;
  try {
    await fs.access(filePath);
    alreadyExists = true;
  } catch {
    // Doesn't exist — fine, first-time write.
  }

  if (alreadyExists) {
    const choice = await vscode.window.showWarningMessage(
      `${filePath} already exists. Overwriting will discard its current content.`,
      { modal: true },
      "Overwrite",
      "Skip"
    );
    if (choice !== "Overwrite") {
      return "skipped";
    }
  }

  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return "written";
}
