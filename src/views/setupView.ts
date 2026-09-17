import * as vscode from "vscode";
import { SybilConfig } from "../config";
import { SybilMcpClient } from "../mcpClient";
import { fetchSybilInfo, fetchMcpJson, fetchClaudeMd } from "../portalClient";
import { writeMcpJson, writeGlobalClaudeMd } from "../fileSetup";

/**
 * Setup wizard. Primary path: Portal URL + token -> auto-configure (fetches
 * owner_id/project list/endpoint/CLAUDE.md from Portal's bearer-auth-capable
 * self-service endpoints, writes .mcp.json + ~/.claude/CLAUDE.md). Manual
 * per-field entry stays available for a Portal-less SybilKB deployment or
 * anyone who wants to skip the file-writing.
 */
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

    webviewView.webview.onDidReceiveMessage(async (message: { command: string; portalUrl?: string; token?: string }) => {
      switch (message.command) {
        case "autoConfigure":
          await this.autoConfigure(webviewView.webview, message.portalUrl ?? "", message.token ?? "");
          break;
        case "setEndpoint":
          await vscode.commands.executeCommand("sybil.setEndpoint");
          this.refresh();
          break;
        case "setToken":
          await vscode.commands.executeCommand("sybil.setToken");
          this.refresh();
          break;
        case "selectProject":
          await vscode.commands.executeCommand("sybil.selectProject");
          this.refresh();
          break;
        case "testConnection":
          await this.testConnection(webviewView.webview);
          break;
      }
    });
  }

  private async autoConfigure(webview: vscode.Webview, portalUrl: string, token: string): Promise<void> {
    if (!portalUrl || !token) {
      webview.postMessage({ command: "autoConfigureResult", ok: false, message: "Portal URL and token are both required." });
      return;
    }

    try {
      webview.postMessage({ command: "autoConfigureProgress", message: "Fetching your Sybil identity…" });
      const info = await fetchSybilInfo(portalUrl, token);

      if (info.project_keys.length === 0) {
        throw new Error("No projects assigned to this account yet — ask an Admin, then retry.");
      }

      const picked = await vscode.window.showQuickPick(info.project_keys, {
        title: "Select the project this workspace works on",
        ignoreFocusOut: true,
      });
      if (!picked) {
        webview.postMessage({ command: "autoConfigureResult", ok: false, message: "Cancelled — no project selected." });
        return;
      }

      webview.postMessage({ command: "autoConfigureProgress", message: "Fetching SybilKB endpoint…" });
      const mcpJson = await fetchMcpJson(portalUrl, token);

      webview.postMessage({ command: "autoConfigureProgress", message: "Fetching your CLAUDE.md template…" });
      const claudeMd = await fetchClaudeMd(portalUrl, token);

      await this.config.setPortalUrl(portalUrl);
      await this.config.setToken(token);
      await this.config.setEndpoint(mcpJson.mcpServers["sybil-kb"].url);
      await this.config.setOwnerId(info.user_id);
      await this.config.setProjectId(picked);
      this.mcp.disconnect();

      const mcpJsonPath = await writeMcpJson(mcpJson, token);
      const claudeMdResult = await writeGlobalClaudeMd(claudeMd);

      webview.postMessage({
        command: "autoConfigureResult",
        ok: true,
        message: `Done. Wrote ${mcpJsonPath}. CLAUDE.md: ${claudeMdResult}. Project: ${picked}.`,
      });
      this.render(webview);
    } catch (err) {
      webview.postMessage({
        command: "autoConfigureResult",
        ok: false,
        message: err instanceof Error ? err.message : "Unknown error.",
      });
    }
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
    const portalUrl = this.config.getPortalUrl();

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
            input { width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 4px; }
            button { display: block; width: 100%; margin-top: 6px; padding: 6px; cursor: pointer; }
            .secondary { opacity: 0.85; }
            #result, #progress { margin-top: 10px; font-size: 0.9em; white-space: pre-wrap; }
            details { margin-top: 14px; }
            summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
          </style>
        </head>
        <body>
          <p><strong>Auto-configure from Portal</strong></p>
          <input id="portalUrl" placeholder="Portal URL, e.g. http://your-portal-host:8000" value="${portalUrl ?? ""}" />
          <input id="autoToken" placeholder="Token from Portal → My Projects → Sybil / Claude Code access" type="password" />
          <button id="btnAutoConfigure">Auto-Configure</button>
          <div id="progress"></div>
          <div id="result"></div>

          <p style="margin-top:16px;"><strong>Current state</strong></p>
          ${row("Portal URL", portalUrl)}
          ${row("Endpoint", endpoint)}
          ${row("Token", token ? "••••••••" : undefined)}
          ${row("Owner ID", ownerId)}
          ${row("Project", projectId)}
          <button id="btnTest">Test Connection</button>

          <details>
            <summary>Manual / advanced setup</summary>
            <button class="secondary" id="btnEndpoint">Set Endpoint URL</button>
            <button class="secondary" id="btnToken">Set Access Token</button>
            <button class="secondary" id="btnProject">Select Project</button>
          </details>

          <script>
            const vscode = acquireVsCodeApi();
            document.getElementById('btnAutoConfigure').onclick = () => {
              vscode.postMessage({
                command: 'autoConfigure',
                portalUrl: document.getElementById('portalUrl').value.trim(),
                token: document.getElementById('autoToken').value.trim(),
              });
            };
            document.getElementById('btnEndpoint').onclick = () => vscode.postMessage({ command: 'setEndpoint' });
            document.getElementById('btnToken').onclick = () => vscode.postMessage({ command: 'setToken' });
            document.getElementById('btnProject').onclick = () => vscode.postMessage({ command: 'selectProject' });
            document.getElementById('btnTest').onclick = () => vscode.postMessage({ command: 'testConnection' });
            window.addEventListener('message', (event) => {
              const msg = event.data;
              if (msg.command === 'autoConfigureProgress') {
                document.getElementById('progress').textContent = msg.message;
                document.getElementById('result').textContent = '';
              } else if (msg.command === 'autoConfigureResult') {
                document.getElementById('progress').textContent = '';
                const el = document.getElementById('result');
                el.style.color = msg.ok ? 'var(--vscode-terminal-ansiGreen)' : 'var(--vscode-errorForeground)';
                el.textContent = msg.message;
              } else if (msg.command === 'testResult') {
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
