import * as vscode from "vscode";
import { SybilMcpClient } from "../mcpClient";

interface QualityGateCondition {
  status: string;
  metricKey: string;
  comparator: string;
  errorThreshold: string;
  actualValue: string;
}

interface QualityGateStatus {
  status: string;
  conditions?: QualityGateCondition[];
  ignoredConditions?: boolean;
}

interface Issue {
  key: string;
  severity: string;
  type: string;
  message: string;
  component: string;
  line?: number;
}

/**
 * Wraps sybil_get_quality_report — gate status + open issues, read-only,
 * never triggers a scan. A project with no SonarQube counterpart yet (the
 * tool returns an error / null quality_gate for that case, confirmed live
 * against a nonexistent project key) shows a plain "not configured" message
 * rather than an error — this is the expected state for most projects until
 * sybil_sonarqube_onboard_project has run and a scan has happened.
 */
export class QualityGateViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

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

    // Quality gate data changes from OUTSIDE this extension (a real
    // sonar-scanner run finishing after a commit), so there's no push
    // signal telling this view to re-fetch — confirmed live (2026-09-26):
    // a fresh scan result only showed up after a manual Refresh click.
    // Re-fetching whenever this panel becomes visible again (switched back
    // to, or the window regains focus while it's the active view) is the
    // cheapest reasonable proxy for "the user probably wants current data."
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.render();
      }
    });
    void this.render();

    webviewView.webview.onDidReceiveMessage(async (message: { command: string }) => {
      if (message.command === "refresh") {
        await this.render();
      }
    });
  }

  private async render(): Promise<void> {
    if (!this.view) return;
    const webview = this.view.webview;

    let qualityGate: QualityGateStatus | null = null;
    let issues: Issue[] = [];
    let issueTotal = 0;
    let notConfigured = false;
    let error: string | undefined;

    try {
      const result = (await this.mcp.callTool("sybil_get_quality_report")) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textBlock = result.content?.find((c) => c.type === "text")?.text;
      if (textBlock) {
        const parsed = JSON.parse(textBlock) as {
          quality_gate?: QualityGateStatus | null;
          issue_total?: number;
          issues?: Issue[];
          error?: string;
        };
        if (parsed.error || !parsed.quality_gate) {
          notConfigured = true;
        } else {
          qualityGate = parsed.quality_gate;
          issues = parsed.issues ?? [];
          issueTotal = parsed.issue_total ?? issues.length;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Unknown error.";
    }

    const conditionRows = (qualityGate?.conditions ?? [])
      .map(
        (c) => `
        <tr class="${c.status === "OK" ? "ok" : "fail"}">
          <td>${escapeHtml(formatMetric(c.metricKey))}</td>
          <td>${escapeHtml(c.actualValue)} ${escapeHtml(comparatorSymbol(c.comparator))} ${escapeHtml(c.errorThreshold)}</td>
          <td>${c.status === "OK" ? "✓" : "✗"}</td>
        </tr>`
      )
      .join("");

    const issueRows = issues
      .slice(0, 30)
      .map(
        (i) => `
        <li class="issue ${i.severity.toLowerCase()}">
          <div class="sev">${escapeHtml(i.severity)} · ${escapeHtml(i.type)}</div>
          <div class="msg">${escapeHtml(i.message)}</div>
          <div class="loc">${escapeHtml(shortComponent(i.component))}${i.line ? `:${i.line}` : ""}</div>
        </li>`
      )
      .join("");

    webview.html = `
      <html>
        <head>
          <style>
            body { font-family: var(--vscode-font-family); padding: 8px; }
            button { margin-bottom: 8px; padding: 4px 8px; cursor: pointer; }
            .empty { color: var(--vscode-descriptionForeground); }
            .warn { color: var(--vscode-terminal-ansiYellow); font-size: 0.85em; margin: 4px 0 8px; }
            .error { color: var(--vscode-errorForeground); }
            .gate-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-weight: 600; margin-bottom: 8px; }
            .gate-badge.OK { background: var(--vscode-terminal-ansiGreen); color: #000; }
            .gate-badge.ERROR { background: var(--vscode-terminal-ansiRed); color: #fff; }
            table { width: 100%; border-collapse: collapse; font-size: 0.9em; margin-bottom: 12px; }
            td { padding: 3px 4px; border-bottom: 1px solid var(--vscode-widget-border); }
            tr.fail td:last-child { color: var(--vscode-terminal-ansiRed); }
            tr.ok td:last-child { color: var(--vscode-terminal-ansiGreen); }
            ul { list-style: none; padding: 0; margin: 0; }
            li.issue { padding: 6px 0; border-bottom: 1px solid var(--vscode-widget-border); font-size: 0.9em; }
            .sev { font-weight: 500; }
            .issue.blocker .sev, .issue.critical .sev { color: var(--vscode-terminal-ansiRed); }
            .issue.major .sev { color: var(--vscode-terminal-ansiYellow); }
            .msg { margin: 2px 0; }
            .loc { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
          </style>
        </head>
        <body>
          <button id="btnRefresh">Refresh</button>
          ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
          ${
            notConfigured
              ? `<p class="empty">No SonarQube project configured yet for this Foundry project — nothing to show until it's onboarded and a scan has run.</p>`
              : ""
          }
          ${
            qualityGate
              ? `
                <span class="gate-badge ${qualityGate.status}">${escapeHtml(qualityGate.status)}</span>
                ${
                  qualityGate.ignoredConditions
                    ? `<p class="warn">⚠ One or more conditions below weren't actually evaluated (e.g. no coverage report imported) — SonarQube shows those as passing rather than failing on missing data. A ✓ here isn't always a real pass; check SonarQube directly if a number looks off.</p>`
                    : ""
                }
                ${
                  conditionRows
                    ? `<table>${conditionRows}</table>`
                    : `<p class="empty">No conditions measured yet (no analysis has run).</p>`
                }
                <p class="empty">${issueTotal} open issue${issueTotal === 1 ? "" : "s"}${issues.length < issueTotal ? ` (showing ${Math.min(issues.length, 30)})` : ""}</p>
                <ul>${issueRows}</ul>
              `
              : ""
          }
          <script>
            const vscode = acquireVsCodeApi();
            document.getElementById('btnRefresh').onclick = () => vscode.postMessage({ command: 'refresh' });
          </script>
        </body>
      </html>
    `;
  }
}

function formatMetric(key: string): string {
  return key.replace(/^new_/, "").replace(/_/g, " ");
}

function comparatorSymbol(comparator: string): string {
  return { LT: "<", GT: ">", EQ: "=", NE: "≠" }[comparator] ?? comparator;
}

function shortComponent(component: string): string {
  const idx = component.indexOf(":");
  return idx >= 0 ? component.slice(idx + 1) : component;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
