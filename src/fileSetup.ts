import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { McpJsonResponse } from "./portalClient";
import { SybilMcpClient } from "./mcpClient";

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

const SONARQUBE_POST_COMMIT_HOOK = `#!/usr/bin/env bash
# Fires a background sonar-scanner run after every commit, reporting to the
# centrally-hosted SonarQube CE server. Never blocks the commit, never runs
# inside a Claude Code / Sybil session -- this is a plain git hook, same
# mechanism as any linter pre-commit hook.
#
# Versioned under .githooks/ (not .git/hooks/) so it ships with the repo on
# any future checkout -- see \`git config core.hooksPath .githooks\`.
#
# Token resolution: env var SONAR_TOKEN, else a gitignored .sonar-token file
# at repo root. Neither is ever committed.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SONAR_HOST_URL="\${SONAR_HOST_URL:-__SONAR_HOST_URL__}"

if [ -z "\${SONAR_TOKEN:-}" ] && [ -f "$REPO_ROOT/.sonar-token" ]; then
    SONAR_TOKEN="$(cat "$REPO_ROOT/.sonar-token")"
fi

if [ -z "\${SONAR_TOKEN:-}" ]; then
    echo "[post-commit] SONAR_TOKEN not set (env or .sonar-token) -- skipping scan." >&2
    exit 0
fi

if ! command -v sonar-scanner >/dev/null 2>&1; then
    echo "[post-commit] sonar-scanner not installed -- skipping scan." >&2
    exit 0
fi

(
    cd "$REPO_ROOT" && \\
    sonar-scanner -Dsonar.host.url="$SONAR_HOST_URL" -Dsonar.token="$SONAR_TOKEN" \\
        >> "$REPO_ROOT/.sonar-scan.log" 2>&1
) &

disown
exit 0
`;

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
 * project and returned a fresh analysis token: sonar-project.properties +
 * .githooks/post-commit (only if neither already exists, to never clobber
 * hand-customized scanner config), always refreshes .sonar-token (that
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
  const hooksDir = path.join(cwd, ".githooks");
  const hookPath = path.join(hooksDir, "post-commit");

  const propertiesExists = await fs
    .access(propertiesPath)
    .then(() => true)
    .catch(() => false);
  if (!propertiesExists) {
    await fs.writeFile(propertiesPath, sonarProjectProperties(projectKey), "utf-8");
    written.push(propertiesPath);
  }

  const hookExists = await fs
    .access(hookPath)
    .then(() => true)
    .catch(() => false);
  if (!hookExists) {
    await fs.mkdir(hooksDir, { recursive: true });
    const hookContent = SONARQUBE_POST_COMMIT_HOOK.replace("__SONAR_HOST_URL__", sonarqubeUrl);
    await fs.writeFile(hookPath, hookContent, "utf-8");
    await fs.chmod(hookPath, 0o755);
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

  if (!hookExists) {
    try {
      await execFileAsync("git", ["config", "core.hooksPath", ".githooks"], { cwd });
    } catch (err) {
      console.error("Sybil: git config core.hooksPath failed (non-fatal — not a git repo yet, or git not on PATH):", err);
    }
  }

  return { status: written.length > 0 ? "written" : "skipped_exists", files: written };
}

/**
 * Fire-and-forget: call sybil_sonarqube_onboard_project, then write the
 * local half if it succeeds. Invisible by design (2026-09-26, Janos: "this
 * could be totally invisible for the user") -- called right after project
 * selection, same as ensureSonarqubeIdentity. Failures are logged, never
 * surfaced, since nothing in this UI currently depends on it existing yet.
 */
export function onboardSonarQubeProject(mcp: SybilMcpClient): void {
  void (async () => {
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
