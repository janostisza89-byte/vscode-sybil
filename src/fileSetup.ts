import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { McpJsonResponse } from "./portalClient";

/**
 * Write/merge .mcp.json into the current workspace root. Merges rather than
 * overwrites — a real dev environment likely has other MCP servers already
 * configured, and this must not clobber them. Embeds the real token
 * directly (the extension already holds it; no ${SYBILKB_TOKEN} env-var
 * indirection needed the way a manually-downloaded file needs).
 */
export async function writeMcpJson(mcpJson: McpJsonResponse, token: string): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("No workspace folder open — open a folder before running auto-configure.");
  }
  const filePath = path.join(folder.uri.fsPath, ".mcp.json");

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    // No existing file, or it's not valid JSON — start fresh either way;
    // an invalid existing file would have been broken for Claude Code too.
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {};
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
