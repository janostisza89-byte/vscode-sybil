import * as vscode from "vscode";
import { SybilConfig } from "../config";
import { SybilMcpClient } from "../mcpClient";

/** Setup wizard: shows current config state, lets the user (re)configure, tests the connection. */
export class SetupViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly config: SybilConfig,
    private readonly mcp: SybilMcpClient
  ) {}

  refresh(): void {
    if (this.view) {
      this.render(this.view.webview);
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.render(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: { command: string }) => {
      switch (message.command) {
        case "setEndpoint":
          await vscode.commands.executeCommand("sybil.setEndpoint");
          break;
        case "setToken":
          await vscode.commands.executeCommand("sybil.setToken");
          break;
        case "selectProject":
          await vscode.commands.executeCommand("sybil.selectProject");
          break;
        case "testConnection":
          await this.testConnection(webviewView.webview);
          break;
      }
    });
  }

  private async testConnection(webview: vscode.Webview): Promise<void> {
    try {
      await this.mcp.callTool("sybil_search", { query: "connection test", max_results: 1 });
      webview.postMessage({ command: "testResult", ok: true, message: "Connected — SybilKB responded." });
    } catch (err) {
      webview.postMessage({
        command: "testResult",
        ok: false,
        message: err instanceof Error ? err.message : "Unknown error.",
      });
    }
  }

  private async render(webview: vscode.Webview): Promise<void> {
    const token = await this.config.getToken();
    const endpoint = this.config.getEndpoint();
    const ownerId = this.config.getOwnerId();
    const projectId = this.config.getProjectId();

    const row = (label: string, value: string | undefined) =>
      `<div class="row"><span class="label">${label}</span><span class="${value ? "ok" : "missing"}">${
        value ?? "not set"
      }</span></div>`;

    webview.html = `
      <html>
        <head>
          <style>
            body { font-family: var(--vscode-font-family); padding: 12px; }
            .row { display: flex; justify-content: space-between; margin-bottom: 6px; }
            .label { color: var(--vscode-descriptionForeground); }
            .ok { color: var(--vscode-terminal-ansiGreen); }
            .missing { color: var(--vscode-terminal-ansiYellow); }
            button { display: block; width: 100%; margin-top: 8px; padding: 6px; cursor: pointer; }
            #result { margin-top: 10px; font-size: 0.9em; white-space: pre-wrap; }
          </style>
        </head>
        <body>
          ${row("Endpoint", endpoint)}
          ${row("Token", token ? "••••••••" : undefined)}
          ${row("Owner ID", ownerId)}
          ${row("Project", projectId)}
          <button id="btnEndpoint">Set Endpoint URL</button>
          <button id="btnToken">Set Access Token</button>
          <button id="btnProject">Select Project</button>
          <button id="btnTest">Test Connection</button>
          <div id="result"></div>
          <script>
            const vscode = acquireVsCodeApi();
            document.getElementById('btnEndpoint').onclick = () => vscode.postMessage({ command: 'setEndpoint' });
            document.getElementById('btnToken').onclick = () => vscode.postMessage({ command: 'setToken' });
            document.getElementById('btnProject').onclick = () => vscode.postMessage({ command: 'selectProject' });
            document.getElementById('btnTest').onclick = () => vscode.postMessage({ command: 'testConnection' });
            window.addEventListener('message', (event) => {
              const msg = event.data;
              if (msg.command === 'testResult') {
                const el = document.getElementById('result');
                el.style.color = msg.ok ? 'var(--vscode-terminal-ansiGreen)' : 'var(--vscode-errorForeground)';
                el.textContent = msg.message;
              }
            });
          </script>
        </body>
      </html>
    `;
  }
}
