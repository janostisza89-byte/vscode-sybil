import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { SybilMcpClient } from "./mcpClient";
import { extractFile, languageForFile } from "./cartographerExtractor";

const execFileAsync = promisify(execFile);

// Mirrors Cartographer's own DEFAULT_EXCLUDE_DIRS (EXP/Cartographer/services/
// graph_ops.py) plus a few this extractor's own broader language coverage
// (JS/TS, not just Python) warrants.
const BACKFILL_EXCLUDE_DIRS = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".git", ".pytest_cache",
  "dist", "build", "coverage", ".scannerwork", ".githooks", "out", ".next", "target", "vendor",
]);

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

export async function getGitInfo(cwd: string): Promise<{ branch?: string; commitSha?: string; dirty: boolean }> {
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

async function collectSupportedFiles(dir: string, repoRoot: string, results: string[] = []): Promise<string[]> {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results; // unreadable dir (permissions, race) -- skip, not fatal
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (BACKFILL_EXCLUDE_DIRS.has(entry.name)) continue;
      await collectSupportedFiles(full, repoRoot, results);
    } else if (entry.isFile()) {
      const rel = path.relative(repoRoot, full).split(path.sep).join("/");
      if (languageForFile(rel)) results.push(rel);
    }
  }
  return results;
}

export interface BackfillResult {
  status: "ok" | "no_files";
  fileCount?: number;
  pushed?: number;
}

/**
 * One-time full-repo scan, run as part of Cartographer onboarding — without
 * it, only files touched in a commit made AFTER onboarding ever get pushed,
 * so every project onboarded this way starts with permanently incomplete
 * data for everything already committed (found live, Cats project,
 * 2026-09-27 — 9+ prior commits were never captured). Mirrors Cartographer's
 * own server-side ensure_indexed: a full pass the first time, not just
 * incremental deltas going forward. Chunked (25 files/call) rather than one
 * giant payload, so a large repo doesn't risk a single oversized request.
 */
export async function backfillRepo(context: vscode.ExtensionContext, mcp: SybilMcpClient, repoRoot: string): Promise<BackfillResult> {
  const files = await collectSupportedFiles(repoRoot, repoRoot);
  if (files.length === 0) {
    return { status: "no_files" };
  }

  const { branch, commitSha, dirty } = await getGitInfo(repoRoot);
  const workspaceId = getWorkspaceId(context);

  const CHUNK_SIZE = 25;
  let pushed = 0;
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    const chunkFiles: Array<{ file_path: string; content_hash: string; nodes: unknown[]; relations: unknown[] }> = [];
    for (const relPath of chunk) {
      try {
        const source = await fs.readFile(path.join(repoRoot, relPath), "utf-8");
        const contentHash = crypto.createHash("sha256").update(source).digest("hex");
        const { nodes, relations } = await extractFile(relPath, source, repoRoot);
        chunkFiles.push({ file_path: relPath, content_hash: contentHash, nodes, relations });
      } catch {
        continue; // unreadable (binary misdetected as text, permission, race) -- skip, not fatal
      }
    }
    if (chunkFiles.length === 0) continue;
    await mcp.callTool("sybil_cartographer_ingest_delta", {
      workspace_id: workspaceId,
      branch: branch ?? "unknown",
      commit_sha: commitSha,
      dirty,
      files: chunkFiles,
    });
    pushed += chunkFiles.length;
  }

  return { status: "ok", fileCount: files.length, pushed };
}
