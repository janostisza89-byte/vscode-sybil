import * as vscode from "vscode";

/** Placeholder for a view not built yet — see extension.ts registration comment. */
export class StubViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly message: string) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = `
      <html>
        <body style="font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-descriptionForeground);">
          <p>${this.message}</p>
        </body>
      </html>
    `;
  }
}
