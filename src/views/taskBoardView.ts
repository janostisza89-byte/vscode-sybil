import * as vscode from "vscode";
import { SybilMcpClient } from "../mcpClient";

interface SybilTask {
  id: string;
  extracted_text: string;
  status: string;
  priority_score: number;
}

/**
 * Task board: lists open/in-progress tasks via sybil_task_list.
 * v1 is read-only + create; closing a task needs resolution_summary,
 * files_changed, validation_result — a real form, deferred to keep this
 * first cut honest about scope (see README roadmap).
 */
export class TaskBoardViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly mcp: SybilMcpClient
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    void this.render();

    webviewView.webview.onDidReceiveMessage(async (message: { command: string }) => {
      if (message.command === "refresh") {
        await this.render();
      } else if (message.command === "newTask") {
        await this.createTask();
      }
    });
  }

  private async createTask(): Promise<void> {
    const title = await vscode.window.showInputBox({ prompt: "Task title", ignoreFocusOut: true });
    if (!title) return;
    const description = await vscode.window.showInputBox({ prompt: "Description", ignoreFocusOut: true });
    try {
      await this.mcp.callTool("sybil_task_open", {
        title,
        description: description ?? "",
        affected_files: [],
      });
      await this.render();
    } catch (err) {
      vscode.window.showErrorMessage(`Sybil: failed to open task — ${err instanceof Error ? err.message : err}`);
    }
  }

  private async render(): Promise<void> {
    if (!this.view) return;
    const webview = this.view.webview;

    let tasks: SybilTask[] = [];
    let error: string | undefined;
    try {
      const result = (await this.mcp.callTool("sybil_task_list")) as {
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
        <li>
          <div class="title">${escapeHtml(t.extracted_text.split("\\n")[0].slice(0, 100))}</div>
          <div class="meta">priority ${t.priority_score} · ${t.status}</div>
        </li>`
      )
      .join("");

    webview.html = `
      <html>
        <head>
          <style>
            body { font-family: var(--vscode-font-family); padding: 8px; }
            button { margin-bottom: 8px; padding: 4px 8px; cursor: pointer; }
            ul { list-style: none; padding: 0; margin: 0; }
            li { padding: 6px 0; border-bottom: 1px solid var(--vscode-widget-border); }
            .title { font-weight: 500; }
            .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
            .error { color: var(--vscode-errorForeground); }
          </style>
        </head>
        <body>
          <button id="btnRefresh">Refresh</button>
          <button id="btnNew">+ New Task</button>
          ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
          ${!error && tasks.length === 0 ? "<p>No open tasks.</p>" : ""}
          <ul>${items}</ul>
          <script>
            const vscode = acquireVsCodeApi();
            document.getElementById('btnRefresh').onclick = () => vscode.postMessage({ command: 'refresh' });
            document.getElementById('btnNew').onclick = () => vscode.postMessage({ command: 'newTask' });
          </script>
        </body>
      </html>
    `;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
