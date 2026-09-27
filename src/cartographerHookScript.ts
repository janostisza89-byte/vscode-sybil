/**
 * Standalone (no vscode import) post-commit push script — bundled separately
 * from extension.js (see esbuild.js) and installed once per machine into
 * this extension's globalStorage, since the wasm grammar binaries shouldn't
 * be committed into every consuming repo the way `.githooks/post-commit`
 * itself is. Invoked by the repo's own post-commit hook via a plain `node`
 * call, reading its own config from a gitignored `.sybil-cartographer.json`
 * at the repo root (a git hook has no access to the extension's own VS Code
 * storage) — see fileSetup.ts's setupCartographerFiles for how that config
 * is written. Runs after every commit, pushes every changed file with a
 * supported extension, best-effort — never blocks or fails the commit
 * itself (the hook backgrounds this + redirects output to a log file).
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import { extractFile, languageForFile } from "./cartographerExtractor";

interface CartographerConfig {
  endpoint: string;
  token: string;
  project_id: string;
  owner_id: string;
  workspace_id: string;
}

function readConfig(repoRoot: string): CartographerConfig | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, ".sybil-cartographer.json"), "utf-8"));
  } catch {
    return undefined;
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

interface DeltaFile {
  file_path: string;
  content_hash: string;
  deleted?: boolean;
  nodes?: unknown[];
  relations?: unknown[];
}

async function buildDeltaFiles(repoRoot: string): Promise<DeltaFile[]> {
  // --root is required for this to show anything on a repo's first (root)
  // commit, which has no parent to diff against otherwise — confirmed live
  // via a scratch test repo (2026-09-27): without it, a fresh repo's very
  // first commit silently pushed nothing.
  const changed = git(["diff-tree", "--no-commit-id", "--name-status", "-r", "--root", "HEAD"], repoRoot)
    .split("\n")
    .filter(Boolean);

  const files: DeltaFile[] = [];
  for (const line of changed) {
    const [status, filePath] = line.split("\t");
    if (!filePath || !languageForFile(filePath)) continue;

    if (status === "D") {
      files.push({ file_path: filePath, content_hash: "", deleted: true });
      continue;
    }

    let source: string;
    try {
      source = fs.readFileSync(path.join(repoRoot, filePath), "utf-8");
    } catch {
      continue; // raced with a later change, or unreadable -- skip, not fatal
    }
    const contentHash = crypto.createHash("sha256").update(source).digest("hex");
    const { nodes, relations } = await extractFile(filePath, source, repoRoot);
    files.push({ file_path: filePath, content_hash: contentHash, nodes, relations });
  }
  return files;
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const config = readConfig(repoRoot);
  if (!config) {
    console.log("[cartographer-push] no .sybil-cartographer.json — skipping.");
    return;
  }

  const files = await buildDeltaFiles(repoRoot);
  if (files.length === 0) {
    console.log("[cartographer-push] no supported-language files changed — skipping.");
    return;
  }

  let branch = "unknown";
  let commitSha: string | undefined;
  let dirty = false;
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    commitSha = git(["rev-parse", "HEAD"], repoRoot);
    dirty = git(["status", "--porcelain"], repoRoot).length > 0;
  } catch {
    // best-effort -- push with defaults rather than aborting entirely
  }

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "sybil_cartographer_ingest_delta",
      arguments: {
        project_id: config.project_id,
        owner_id: config.owner_id,
        workspace_id: config.workspace_id,
        branch,
        commit_sha: commitSha,
        dirty,
        files,
      },
    },
  };

  const resp = await fetch(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify(payload),
  });
  const body = await resp.text();
  console.log(`[cartographer-push] pushed ${files.length} file(s) -- HTTP ${resp.status}: ${body}`);
}

main().catch((err) => {
  console.error("[cartographer-push] unexpected failure:", err);
});
