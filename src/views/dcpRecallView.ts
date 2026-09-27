import * as vscode from "vscode";
import { SybilMcpClient } from "../mcpClient";

interface RecallResult {
  primary_block?: string;
  associative_block?: string;
  summaries_retrieved?: number;
  chunks_retrieved?: number;
  conflict_warning?: string;
  error?: string;
}

/**
 * Wraps sybil_recall — DCP episodic recall (decisions, historical context).
 * Pull-based, same shape as Docs Search: one query box, one render per
 * submit. No push/sync concerns — it only ever shows the result of the
 * last query actually run, there's no ambient status to go stale.
 */
export class DcpRecallViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private lastQuery = "";
  private lastKeyword = "";
  private lastResultText: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly mcp: SybilMcpClient
  ) {}

  refresh(): void {
    void this.render();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    void this.render();

    webviewView.webview.onDidReceiveMessage(
      async (message: { command: string; query?: string; keyword?: string }) => {
        switch (message.command) {
          case "recall":
            if (message.query) {
              this.lastQuery = message.query;
              this.lastKeyword = message.keyword ?? "";
              await this.render();
            }
            break;
          case "refresh":
            await this.render();
            break;
          case "openInEditor":
            await this.openInEditor();
            break;
        }
      }
    );
  }

  /** Opens the currently displayed recall blocks full-size in an editor tab, next to the sidebar. */
  private async openInEditor(): Promise<void> {
    if (!this.lastResultText) return;
    const doc = await vscode.workspace.openTextDocument({
      content: `# DCP Recall: ${this.lastQuery}\n\n${this.lastResultText}`,
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  private async render(): Promise<void> {
    if (!this.view) return;
    const webview = this.view.webview;

    const body = this.lastQuery
      ? await this.renderRecall(this.lastQuery, this.lastKeyword)
      : `<p class="empty">Recall past decisions and historical context from DCP.</p>`;

    webview.html = `
      <html>
        <head><style>${STYLES}</style></head>
        <body>
          <input id="queryBox" type="text" placeholder="What was decided about…? (Enter to recall)" value="${escapeHtml(this.lastQuery)}" />
          <input id="keywordBox" type="text" placeholder="Optional keyword filter" value="${escapeHtml(this.lastKeyword)}" />
          <button id="btnRefresh">Refresh</button>
          ${body}
          <script>
            const vscode = acquireVsCodeApi();
            const queryBox = document.getElementById('queryBox');
            const keywordBox = document.getElementById('keywordBox');
            const submit = () => {
              const q = queryBox.value.trim();
              if (q) vscode.postMessage({ command: 'recall', query: q, keyword: keywordBox.value.trim() });
            };
            queryBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
            keywordBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
            document.getElementById('btnRefresh').onclick = () => vscode.postMessage({ command: 'refresh' });
            const btnOpenEditor = document.getElementById('btnOpenEditor');
            if (btnOpenEditor) btnOpenEditor.onclick = () => vscode.postMessage({ command: 'openInEditor' });
          </script>
        </body>
      </html>
    `;
  }

  private async renderRecall(query: string, keyword: string): Promise<string> {
    let result: RecallResult = {};
    try {
      const raw = (await this.mcp.callTool("sybil_recall", keyword ? { query, keyword } : { query })) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textBlock = raw.content?.find((c) => c.type === "text")?.text;
      if (textBlock) result = JSON.parse(textBlock) as RecallResult;
    } catch (err) {
      result = { error: err instanceof Error ? err.message : "Unknown error." };
    }

    if (result.error) {
      this.lastResultText = undefined;
      return `<p class="error">${escapeHtml(result.error)}</p>`;
    }
    if (!result.primary_block && !result.associative_block) {
      this.lastResultText = undefined;
      return `<p class="empty">No DCP memory matched "${escapeHtml(query)}".</p>`;
    }

    this.lastResultText = [result.primary_block, result.associative_block].filter(Boolean).join("\n\n---\n\n");

    return `
      ${result.conflict_warning ? `<p class="warn">⚠ ${escapeHtml(result.conflict_warning)}</p>` : ""}
      <div class="meta">${result.summaries_retrieved ?? 0} summaries · ${result.chunks_retrieved ?? 0} chunks</div>
      <button id="btnOpenEditor">Open in editor ↗</button>
      ${result.primary_block ? `<pre class="recall">${escapeHtml(result.primary_block)}</pre>` : ""}
      ${
        result.associative_block
          ? `<div class="section"><strong>Associative context</strong><pre class="recall">${escapeHtml(result.associative_block)}</pre></div>`
          : ""
      }
    `;
  }
}

const STYLES = `
  body { font-family: var(--vscode-font-family); padding: 8px; }
  button { margin-bottom: 8px; padding: 4px 8px; cursor: pointer; }
  input[type="text"] {
    display: block; width: 100%; box-sizing: border-box; margin-bottom: 6px;
    padding: 4px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);
  }
  .empty { color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  .warn { color: var(--vscode-terminal-ansiYellow); font-size: 0.85em; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 6px; }
  .section { margin-top: 10px; }
  .recall {
    white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em; background: var(--vscode-textCodeBlock-background);
    padding: 8px; border-radius: 3px; max-height: 400px; overflow-y: auto;
  }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
