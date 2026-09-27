import * as vscode from "vscode";
import { SybilMcpClient } from "../mcpClient";

interface SearchSource {
  file_name: string;
  tier: string;
  confidence_score?: number;
  chunk_excerpt?: string;
}

interface SearchResult {
  grounding_block?: string;
  confidence?: number;
  confidence_tier?: string;
  sources?: SearchSource[];
  error?: string;
}

interface ModuleResult {
  module?: string;
  grounding_block?: string;
  confidence?: number;
  sources?: SearchSource[];
  error?: string;
}

type Mode = "search" | "module";

/**
 * Wraps sybil_search (semantic doc search across CAGI) and sybil_get_module
 * (single-module README/status lookup). Pull-based like Task Board/Quality
 * Gate — the user types a query, this calls the tool once and renders the
 * result. No push/sync concerns: unlike Quality Gate (which shows a status
 * that changes from outside VS Code), nothing here goes stale on its own —
 * it only ever shows the result of the last query actually run.
 */
export class DocsSearchViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private mode: Mode = "search";
  private lastQuery = "";
  private lastModuleName = "";
  private lastResultText: string | undefined;
  private lastResultTitle = "Sybil docs result";

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
      async (message: { command: string; query?: string; name?: string }) => {
        switch (message.command) {
          case "search":
            if (message.query) {
              this.mode = "search";
              this.lastQuery = message.query;
              await this.render();
            }
            break;
          case "lookupModule":
            if (message.name) {
              this.mode = "module";
              this.lastModuleName = message.name;
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

  /** Opens the currently displayed grounding block full-size in an editor tab, next to the sidebar. */
  private async openInEditor(): Promise<void> {
    if (!this.lastResultText) return;
    const doc = await vscode.workspace.openTextDocument({
      content: `# ${this.lastResultTitle}\n\n${this.lastResultText}`,
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  private async render(): Promise<void> {
    if (!this.view) return;
    const webview = this.view.webview;

    let body: string;
    if (this.mode === "module" && this.lastModuleName) {
      body = await this.renderModule(this.lastModuleName);
    } else if (this.lastQuery) {
      body = await this.renderSearch(this.lastQuery);
    } else {
      body = `<p class="empty">Search project documentation, or look up a specific module by name.</p>`;
    }

    webview.html = `
      <html>
        <head><style>${STYLES}</style></head>
        <body>
          <input id="searchBox" type="text" placeholder="Search docs… (Enter to search)" value="${escapeHtml(this.mode === "search" ? this.lastQuery : "")}" />
          <input id="moduleBox" type="text" placeholder="Look up module by name… (Enter)" value="${escapeHtml(this.mode === "module" ? this.lastModuleName : "")}" />
          <button id="btnRefresh">Refresh</button>
          ${body}
          <script>
            const vscode = acquireVsCodeApi();
            document.getElementById('btnRefresh').onclick = () => vscode.postMessage({ command: 'refresh' });
            document.getElementById('searchBox').addEventListener('keydown', (e) => {
              if (e.key === 'Enter' && e.target.value.trim()) {
                vscode.postMessage({ command: 'search', query: e.target.value.trim() });
              }
            });
            document.getElementById('moduleBox').addEventListener('keydown', (e) => {
              if (e.key === 'Enter' && e.target.value.trim()) {
                vscode.postMessage({ command: 'lookupModule', name: e.target.value.trim() });
              }
            });
            document.querySelectorAll('.source-link').forEach((el) => {
              el.onclick = () => vscode.postMessage({ command: 'lookupModule', name: el.dataset.moduleGuess });
            });
            const btnOpenEditor = document.getElementById('btnOpenEditor');
            if (btnOpenEditor) btnOpenEditor.onclick = () => vscode.postMessage({ command: 'openInEditor' });
          </script>
        </body>
      </html>
    `;
  }

  private async renderSearch(query: string): Promise<string> {
    let result: SearchResult = {};
    try {
      const raw = (await this.mcp.callTool("sybil_search", { query })) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textBlock = raw.content?.find((c) => c.type === "text")?.text;
      if (textBlock) result = JSON.parse(textBlock) as SearchResult;
    } catch (err) {
      result = { error: err instanceof Error ? err.message : "Unknown error." };
    }

    if (result.error) {
      this.lastResultText = undefined;
      return `<p class="error">${escapeHtml(result.error)}</p>`;
    }
    if (!result.grounding_block) {
      this.lastResultText = undefined;
      return `<p class="empty">No matches for "${escapeHtml(query)}".</p>`;
    }

    this.lastResultText = result.grounding_block;
    this.lastResultTitle = `Docs Search: ${query}`;

    return `
      <div class="meta">confidence: ${escapeHtml(result.confidence_tier ?? "unknown")} (${((result.confidence ?? 0) * 100).toFixed(0)}%)</div>
      <button id="btnOpenEditor">Open in editor ↗</button>
      <pre class="grounding">${escapeHtml(result.grounding_block)}</pre>
      ${renderSources(result.sources)}
    `;
  }

  private async renderModule(name: string): Promise<string> {
    let result: ModuleResult = {};
    try {
      const raw = (await this.mcp.callTool("sybil_get_module", { name })) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textBlock = raw.content?.find((c) => c.type === "text")?.text;
      if (textBlock) result = JSON.parse(textBlock) as ModuleResult;
    } catch (err) {
      result = { error: err instanceof Error ? err.message : "Unknown error." };
    }

    if (result.error) {
      this.lastResultText = undefined;
      return `<p class="error">${escapeHtml(result.error)}</p>`;
    }
    if (!result.grounding_block) {
      this.lastResultText = undefined;
      return `<p class="empty">No documentation found for module "${escapeHtml(name)}".</p>`;
    }

    this.lastResultText = result.grounding_block;
    this.lastResultTitle = `Module: ${result.module ?? name}`;

    return `
      <div class="detail-title">${escapeHtml(result.module ?? name)}</div>
      <button id="btnOpenEditor">Open in editor ↗</button>
      <pre class="grounding">${escapeHtml(result.grounding_block)}</pre>
      ${renderSources(result.sources)}
    `;
  }
}

/**
 * sybil_get_module's lookup is itself semantic/best-effort (a query string
 * built around the name, not an exact key), so a rough file_name -> module
 * name guess is good enough here — stripping the "_README.md" convention
 * documented in Foundry_v2/CLAUDE.md's CAGI Sync Rules, or just ".md" for
 * root docs that keep their own name.
 */
function moduleGuessFromFileName(fileName: string): string {
  return fileName.replace(/_README\.md$/i, "").replace(/\.md$/i, "");
}

function renderSources(sources: SearchSource[] | undefined): string {
  if (!sources || sources.length === 0) return "";
  const rows = sources
    .map(
      (s) => `
      <li class="source-link" data-module-guess="${escapeHtml(moduleGuessFromFileName(s.file_name))}">
        <span class="file">${escapeHtml(s.file_name)}</span>
        <span class="tier">${escapeHtml(s.tier)}</span>
        ${s.confidence_score !== undefined ? `<span class="meta">${(s.confidence_score * 100).toFixed(0)}%</span>` : ""}
      </li>`
    )
    .join("");
  return `<div class="section"><strong>Sources</strong><ul>${rows}</ul></div>`;
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
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .detail-title { font-weight: 600; margin-bottom: 6px; }
  .grounding {
    white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em; background: var(--vscode-textCodeBlock-background);
    padding: 8px; border-radius: 3px; max-height: 400px; overflow-y: auto;
  }
  .section { margin-top: 10px; }
  ul { list-style: none; padding: 0; margin: 4px 0 0; }
  li.source-link {
    cursor: pointer; padding: 4px 0; border-bottom: 1px solid var(--vscode-widget-border);
    display: flex; gap: 8px; align-items: baseline; font-size: 0.85em;
  }
  li.source-link:hover { background: var(--vscode-list-hoverBackground); }
  .file { font-weight: 500; }
  .tier { color: var(--vscode-descriptionForeground); }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
