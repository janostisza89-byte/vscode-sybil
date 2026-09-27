import * as vscode from "vscode";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { SybilMcpClient } from "./mcpClient";
import { extractFile, languageForFile } from "./cartographerExtractor";

const execFileAsync = promisify(execFile);

const WORKSPACE_ID_KEY = "sybil.cartographerWorkspaceId";

/**
 * Stable per-workspace id, generated once and persisted in this extension's
 * own workspaceState — not derived from machine/path, since either can
 * change (a repo moved, cloned again) without this being a genuinely
 * different workspace for Cartographer's purposes.
 */
export function getWorkspaceId(context: vscode.ExtensionContext): string {
  let id = context.workspaceState.get<string>(WORKSPACE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    void context.workspaceState.update(WORKSPACE_ID_KEY, id);
  }
  return id;
}

async function getGitInfo(cwd: string): Promise<{ branch?: string; commitSha?: string; dirty: boolean }> {
  try {
    const [branchResult, shaResult, statusResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
      execFileAsync("git", ["status", "--porcelain"], { cwd }),
    ]);
    return {
      branch: branchResult.stdout.trim(),
      commitSha: shaResult.stdout.trim(),
      dirty: statusResult.stdout.trim().length > 0,
    };
  } catch {
    return { dirty: false };
  }
}

/**
 * Cartographer Redesign Stage 1 (task 13cb479c) — Slice 3: one-shot,
 * current-file-only extract-and-push. No file watcher yet (deferred, per
 * the incremental build plan) — this is a manually-triggered command that
 * proves the whole path: local parse -> delta payload -> sybil_cartographer_
 * ingest_delta -> Cartographer's isolated staging tables.
 */
export async function extractAndPushCurrentFile(context: vscode.ExtensionContext, mcp: SybilMcpClient): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Sybil: no active editor.");
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!folder) {
    vscode.window.showWarningMessage("Sybil: file is not inside an open workspace folder.");
    return;
  }

  const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
  if (!languageForFile(relPath)) {
    vscode.window.showWarningMessage("Sybil: unsupported file type (Python, JS, TS, TSX only for now).");
    return;
  }

  const cwd = folder.uri.fsPath;
  const source = editor.document.getText();
  const contentHash = crypto.createHash("sha256").update(source).digest("hex");

  const { nodes, relations } = await extractFile(relPath, source, cwd);
  const { branch, commitSha, dirty } = await getGitInfo(cwd);
  const workspaceId = getWorkspaceId(context);

  try {
    const raw = (await mcp.callTool("sybil_cartographer_ingest_delta", {
      workspace_id: workspaceId,
      branch: branch ?? "unknown",
      commit_sha: commitSha,
      dirty,
      files: [{ file_path: relPath, content_hash: contentHash, nodes, relations }],
    })) as { content?: Array<{ type: string; text?: string }> };
    const textBlock = raw.content?.find((c) => c.type === "text")?.text;
    const parsed = textBlock ? JSON.parse(textBlock) : {};
    vscode.window.showInformationMessage(
      `Sybil: pushed ${nodes.length} node(s), ${relations.length} relation(s) for ${relPath} ` +
        `(branch ${branch ?? "unknown"}${dirty ? ", dirty" : ""}). Server: ${JSON.stringify(parsed)}`
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Sybil: Cartographer delta push failed — ${err instanceof Error ? err.message : err}`);
  }
}
