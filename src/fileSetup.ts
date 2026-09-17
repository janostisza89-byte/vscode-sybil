import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { McpJsonResponse } from "./portalClient";

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
export async function writeMcpJson(mcpJson: McpJsonResponse, token: string): Promise<string> {
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
  return filePath;
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
