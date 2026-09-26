import * as vscode from "vscode";
import { SybilMcpClient } from "../mcpClient";

interface SybilTask {
  id: string;
  extracted_text: string;
  status: string;
  priority_score: number;
}

interface SybilTaskDetail extends SybilTask {
  created_at?: string;
  resolved_at?: string | null;
  resolution_text?: string | null;
  progress_notes?: string | null;
  context_snippet?: string | null;
  project_id?: string;
}

// Exactly the enum sybil_task_list's `status` param accepts, plus the
// no-value default (server-side: "Open and In Progress"). No synthetic "All"
// option — that's not a real filter value the tool supports.
const STATUS_FILTERS = ["Open", "In Progress", "Completed", "Obsolete", "Stale"] as const;

/**
 * Task board: lists open/in-progress tasks via sybil_task_list, drills into
 * one via sybil_task_get, and closes it via sybil_task_close (2026-09-26 —
 * previously read-only + create only, see git history for the earlier gap).
 */
export class TaskBoardViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private selectedTaskId: string | undefined;
  private statusFilter: (typeof STATUS_FILTERS)[number] | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly mcp: SybilMcpClient
  ) {}

  /**
   * Re-run sybil_task_list. Without this, the board only re-checks when its
   * own webview posts "refresh" — so finishing Setup (endpoint/token/project
   * all changing) left a stale "not configured" error on screen until the
   * user manually clicked this view's own Refresh button (2026-09-26,
   * confirmed live). Called from extension.ts wherever config changes.
   */
  refresh(): void {
    void this.render();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    void this.render();

    webviewView.webview.onDidReceiveMessage(
      async (message: { command: string; taskId?: string; status?: string; priority?: number }) => {
        switch (message.command) {
          case "refresh":
            await this.render();
            break;
          case "newTask":
            await this.createTask();
            break;
          case "viewTask":
            this.selectedTaskId = message.taskId;
            await this.render();
            break;
          case "backToList":
            this.selectedTaskId = undefined;
            await this.render();
            break;
          case "closeTask":
            if (message.taskId) {
              await this.closeTask(message.taskId);
            }
            break;
          case "editTask":
            if (message.taskId) {
              await this.editTask(message.taskId);
            }
            break;
          case "obsoleteTask":
            if (message.taskId) {
              await this.obsoleteTask(message.taskId);
            }
            break;
          case "reactivateTask":
            if (message.taskId) {
              await this.reactivateTask(message.taskId);
            }
            break;
          case "setPriority":
            if (message.taskId && message.priority !== undefined) {
              await this.setPriority(message.taskId, message.priority);
            }
            break;
          case "setStatusFilter":
            this.statusFilter = (message.status as (typeof STATUS_FILTERS)[number]) || undefined;
            await this.render();
            break;
        }
      }
    );
  }

  private async createTask(): Promise<void> {
    const title = await vscode.window.showInputBox({ prompt: "Task title", ignoreFocusOut: true });
    if (!title) return;
    const description = await vscode.window.showInputBox({ prompt: "Description", ignoreFocusOut: true });
    if (description === undefined) return;

    const priorityRaw = await vscode.window.showInputBox({
      prompt: "Priority (1 = highest, 5 = lowest)",
      value: "3",
      ignoreFocusOut: true,
      validateInput: (v) => (/^[1-5]$/.test(v.trim()) ? undefined : "Enter a number from 1 to 5."),
    });
    if (priorityRaw === undefined) return;

    try {
      await this.mcp.callTool("sybil_task_open", {
        title,
        description,
        affected_files: [],
        priority: Number(priorityRaw.trim()),
      });
      await this.render();
    } catch (err) {
      vscode.window.showErrorMessage(`Sybil: failed to open task — ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Edit description and/or priority via sybil_task_update. Each field is
   * pre-filled with its current value; cancelling (Escape) that box leaves
   * that field unchanged, mirroring the tool's own "omit to leave unchanged"
   * contract — not treated as clearing it.
   */
  private async editTask(taskId: string): Promise<void> {
    const { task, error } = await this.fetchTaskDetail(taskId);
    if (error || !task) {
      vscode.window.showErrorMessage(`Sybil: can't edit — ${error ?? "task not found"}`);
      return;
    }

    const newText = await vscode.window.showInputBox({
      prompt: "Task description (Escape to leave unchanged)",
      value: task.extracted_text,
      ignoreFocusOut: true,
    });

    const newPriorityRaw = await vscode.window.showInputBox({
      prompt: "Priority 1-5 (Escape to leave unchanged)",
      value: String(task.priority_score),
      ignoreFocusOut: true,
      validateInput: (v) => (v === "" || /^[1-5]$/.test(v.trim()) ? undefined : "Enter a number from 1 to 5, or Escape."),
    });

    const args: Record<string, unknown> = { task_id: taskId };
    if (newText !== undefined && newText !== task.extracted_text) args.extracted_text = newText;
    if (newPriorityRaw !== undefined && Number(newPriorityRaw.trim()) !== task.priority_score) {
      args.priority = Number(newPriorityRaw.trim());
    }
    if (Object.keys(args).length === 1) {
      return; // nothing actually changed — don't call the tool for a no-op
    }

    try {
      await this.mcp.callTool("sybil_task_update", args);
      await this.render();
      vscode.window.showInformationMessage("Sybil: task updated.");
    } catch (err) {
      vscode.window.showErrorMessage(`Sybil: failed to update task — ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Quick priority-only change — no need to go through the full Edit prompt sequence. */
  private async setPriority(taskId: string, priority: number): Promise<void> {
    try {
      await this.mcp.callTool("sybil_task_update", { task_id: taskId, priority });
      await this.render();
    } catch (err) {
      vscode.window.showErrorMessage(`Sybil: failed to set priority — ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Mark Obsolete — distinct from Complete: "this doesn't need doing", not
   * "this got done". Uses sybil_task_obsolete (2026-09-26 — added to
   * SybilKB specifically so this UI could do what Portal's Control Room
   * already does directly against ZeigarnikClerk).
   */
  private async obsoleteTask(taskId: string): Promise<void> {
    const reason = await vscode.window.showInputBox({
      prompt: "Why doesn't this need doing? (optional)",
      ignoreFocusOut: true,
    });
    if (reason === undefined) return; // cancelled
    try {
      await this.mcp.callTool("sybil_task_obsolete", { task_id: taskId, reason: reason || undefined });
      this.selectedTaskId = undefined;
      await this.render();
      vscode.window.showInformationMessage("Sybil: task marked obsolete.");
    } catch (err) {
      vscode.window.showErrorMessage(`Sybil: failed to mark obsolete — ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Reopen a Completed/Obsolete task back to Open, via sybil_task_reactivate. */
  private async reactivateTask(taskId: string): Promise<void> {
    try {
      await this.mcp.callTool("sybil_task_reactivate", { task_id: taskId });
      await this.render();
      vscode.window.showInformationMessage("Sybil: task reactivated.");
    } catch (err) {
      vscode.window.showErrorMessage(`Sybil: failed to reactivate — ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Prompts for the three fields sybil_task_close requires (resolution_summary,
   * files_changed, validation_result) as a sequence of input boxes — same
   * pattern as createTask's two-box sequence, not a bespoke webview form.
   * Cancelling any box aborts without calling the tool.
   */
  private async closeTask(taskId: string): Promise<void> {
    const resolutionSummary = await vscode.window.showInputBox({
      prompt: "Resolution summary — what was changed and the outcome",
      ignoreFocusOut: true,
    });
    if (!resolutionSummary) return;

    const filesChangedRaw = await vscode.window.showInputBox({
      prompt: "Files changed (comma-separated relative paths, or leave blank for none)",
      ignoreFocusOut: true,
    });
    if (filesChangedRaw === undefined) return;

    const validationResult = await vscode.window.showInputBox({
      prompt: "Validation result (e.g. 'tests passed', 'manual review required')",
      ignoreFocusOut: true,
    });
    if (validationResult === undefined) return;

    const filesChanged = filesChangedRaw
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);

    try {
      await this.mcp.callTool("sybil_task_close", {
        task_id: taskId,
        resolution_summary: resolutionSummary,
        files_changed: filesChanged,
        validation_result: validationResult || "not specified",
      });
      this.selectedTaskId = undefined;
      await this.render();
      vscode.window.showInformationMessage("Sybil: task closed.");
    } catch (err) {
      vscode.window.showErrorMessage(`Sybil: failed to close task — ${err instanceof Error ? err.message : err}`);
    }
  }

  private async fetchTaskDetail(taskId: string): Promise<{ task?: SybilTaskDetail; error?: string }> {
    try {
      const result = (await this.mcp.callTool("sybil_task_get", { task_id: taskId })) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textBlock = result.content?.find((c) => c.type === "text")?.text;
      if (!textBlock) return { error: "Empty response." };
      const parsed = JSON.parse(textBlock) as { task?: SybilTaskDetail; status?: string; reason?: string };
      if (!parsed.task) return { error: parsed.reason ?? `Task lookup failed (status: ${parsed.status ?? "unknown"}).` };
      return { task: parsed.task };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Unknown error." };
    }
  }

  private async render(): Promise<void> {
    if (!this.view) return;
    const webview = this.view.webview;

    if (this.selectedTaskId) {
      webview.html = await this.renderDetail(this.selectedTaskId);
      return;
    }

    let tasks: SybilTask[] = [];
    let error: string | undefined;
    try {
      const result = (await this.mcp.callTool(
        "sybil_task_list",
        this.statusFilter ? { status: this.statusFilter } : {}
      )) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textBlock = result.content?.find((c) => c.type === "text")?.text;
      if (textBlock) {
        const parsed = JSON.parse(textBlock) as { tasks?: SybilTask[] };
        tasks = parsed.tasks ?? [];
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Unknown error.";
    }

    const items = tasks
      .map(
        (t) => `
        <li class="clickable" data-task-id="${escapeHtml(t.id)}" data-search="${escapeHtml(t.extracted_text.toLowerCase())}">
          <div class="title">${escapeHtml(t.extracted_text.split("\\n")[0].slice(0, 100))}</div>
          <div class="meta">priority ${t.priority_score} · ${t.status}</div>
        </li>`
      )
      .join("");

    const statusOptions = STATUS_FILTERS.map(
      (s) => `<option value="${s}" ${this.statusFilter === s ? "selected" : ""}>${s}</option>`
    ).join("");

    webview.html = `
      <html>
        <head>
          <style>${STYLES}</style>
        </head>
        <body>
          <button id="btnRefresh">Refresh</button>
          <button id="btnNew">+ New Task</button>
          <select id="statusFilter">
            <option value="" ${!this.statusFilter ? "selected" : ""}>Open + In Progress (default)</option>
            ${statusOptions}
          </select>
          <input id="searchBox" type="text" placeholder="Filter loaded tasks…" />
          ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
          ${!error && tasks.length === 0 ? "<p>No tasks for this filter.</p>" : ""}
          <ul>${items}</ul>
          <script>
            const vscode = acquireVsCodeApi();
            document.getElementById('btnRefresh').onclick = () => vscode.postMessage({ command: 'refresh' });
            document.getElementById('btnNew').onclick = () => vscode.postMessage({ command: 'newTask' });
            document.getElementById('statusFilter').onchange = (e) =>
              vscode.postMessage({ command: 'setStatusFilter', status: e.target.value });
            document.getElementById('searchBox').oninput = (e) => {
              const q = e.target.value.trim().toLowerCase();
              document.querySelectorAll('li.clickable').forEach((li) => {
                li.style.display = !q || (li.dataset.search || '').includes(q) ? '' : 'none';
              });
            };
            document.querySelectorAll('li.clickable').forEach((li) => {
              li.onclick = () => vscode.postMessage({ command: 'viewTask', taskId: li.dataset.taskId });
            });
          </script>
        </body>
      </html>
    `;
  }

  private async renderDetail(taskId: string): Promise<string> {
    const { task, error } = await this.fetchTaskDetail(taskId);

    const closed = task && (task.status === "Completed" || task.status === "Obsolete");

    const body = error
      ? `<p class="error">${escapeHtml(error)}</p>`
      : `
        <div class="detail-title">${escapeHtml(task!.extracted_text)}</div>
        <div class="meta">priority ${task!.priority_score} · ${task!.status}</div>
        ${task!.created_at ? `<div class="meta">opened ${escapeHtml(task!.created_at)}</div>` : ""}
        ${task!.resolved_at ? `<div class="meta">resolved ${escapeHtml(task!.resolved_at)}</div>` : ""}
        ${
          task!.context_snippet && task!.context_snippet !== task!.extracted_text
            ? `<div class="section"><strong>Context</strong><p class="italic">${escapeHtml(task!.context_snippet)}</p></div>`
            : ""
        }
        ${task!.resolution_text ? `<div class="section"><strong>Resolution</strong><p>${escapeHtml(task!.resolution_text)}</p></div>` : ""}
        ${task!.progress_notes ? `<div class="section"><strong>Progress notes</strong><p>${escapeHtml(task!.progress_notes)}</p></div>` : ""}
        <div class="section">
          <button id="btnEdit">Edit</button>
          ${closed ? `<button id="btnReactivate">Reactivate</button>` : `<button id="btnComplete">Complete</button><button id="btnObsolete">Mark Obsolete</button>`}
        </div>
        <div class="section priority-set">
          <span class="meta">Priority:</span>
          <input id="priorityInput" type="number" min="1" max="5" value="${task!.priority_score}" />
          <button id="btnSetPriority">Set</button>
        </div>
      `;

    return `
      <html>
        <head>
          <style>${STYLES}</style>
        </head>
        <body>
          <button id="btnBack">← Back</button>
          ${body}
          <script>
            const vscode = acquireVsCodeApi();
            const taskId = ${JSON.stringify(taskId)};
            document.getElementById('btnBack').onclick = () => vscode.postMessage({ command: 'backToList' });
            const btnComplete = document.getElementById('btnComplete');
            if (btnComplete) btnComplete.onclick = () => vscode.postMessage({ command: 'closeTask', taskId });
            const btnObsolete = document.getElementById('btnObsolete');
            if (btnObsolete) btnObsolete.onclick = () => vscode.postMessage({ command: 'obsoleteTask', taskId });
            const btnReactivate = document.getElementById('btnReactivate');
            if (btnReactivate) btnReactivate.onclick = () => vscode.postMessage({ command: 'reactivateTask', taskId });
            const btnEdit = document.getElementById('btnEdit');
            if (btnEdit) btnEdit.onclick = () => vscode.postMessage({ command: 'editTask', taskId });
            const btnSetPriority = document.getElementById('btnSetPriority');
            if (btnSetPriority) {
              btnSetPriority.onclick = () => {
                const v = Number(document.getElementById('priorityInput').value);
                if (v >= 1 && v <= 5) vscode.postMessage({ command: 'setPriority', taskId, priority: v });
              };
            }
          </script>
        </body>
      </html>
    `;
  }
}

const STYLES = `
  body { font-family: var(--vscode-font-family); padding: 8px; }
  button { margin-bottom: 8px; padding: 4px 8px; cursor: pointer; }
  select, input[type="text"] {
    display: block; width: 100%; box-sizing: border-box; margin-bottom: 8px;
    padding: 4px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);
  }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 6px 0; border-bottom: 1px solid var(--vscode-widget-border); }
  li.clickable { cursor: pointer; }
  li.clickable:hover { background: var(--vscode-list-hoverBackground); }
  .title { font-weight: 500; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .error { color: var(--vscode-errorForeground); }
  .detail-title { font-weight: 500; margin-bottom: 6px; white-space: pre-wrap; }
  .section { margin-top: 10px; }
  .section p { white-space: pre-wrap; margin: 4px 0 0; }
  .section p.italic { font-style: italic; color: var(--vscode-descriptionForeground); }
  .section button { display: inline-block; width: auto; margin-right: 6px; }
  .priority-set input { display: inline-block; width: 50px; margin: 0 6px; }
  .priority-set button { display: inline-block; width: auto; }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
