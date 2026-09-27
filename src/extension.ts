import * as vscode from "vscode";
import { SybilConfig } from "./config";
import { SybilMcpClient } from "./mcpClient";
import { SetupViewProvider } from "./views/setupView";
import { TaskBoardViewProvider } from "./views/taskBoardView";
import { QualityGateViewProvider } from "./views/qualityGateView";
import { DocsSearchViewProvider } from "./views/docsSearchView";
import { DcpRecallViewProvider } from "./views/dcpRecallView";
import { addPlaywrightMcp, onboardProjectIntegrations } from "./fileSetup";
import { extractAndPushCurrentFile } from "./cartographerPush";

export function activate(context: vscode.ExtensionContext): void {
  const config = new SybilConfig(context);
  const mcp = new SybilMcpClient(config);

  const taskBoardView = new TaskBoardViewProvider(context, mcp);
  const qualityGateView = new QualityGateViewProvider(context, mcp);
  const docsSearchView = new DocsSearchViewProvider(context, mcp);
  const dcpRecallView = new DcpRecallViewProvider(context, mcp);
  const setupView = new SetupViewProvider(context, config, mcp, () => {
    taskBoardView.refresh();
    qualityGateView.refresh();
    docsSearchView.refresh();
    dcpRecallView.refresh();
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("sybil.setup", setupView),
    vscode.window.registerWebviewViewProvider("sybil.taskBoard", taskBoardView),
    vscode.window.registerWebviewViewProvider("sybil.qualityGate", qualityGateView),
    vscode.window.registerWebviewViewProvider("sybil.docsSearch", docsSearchView),
    vscode.window.registerWebviewViewProvider("sybil.dcpRecall", dcpRecallView),

    vscode.commands.registerCommand("sybil.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "SybilKB access token (from Portal → My Projects → Sybil/Claude Code access)",
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await config.setToken(token);
        mcp.disconnect();
        setupView.refresh();
        taskBoardView.refresh();
        qualityGateView.refresh();
        docsSearchView.refresh();
        dcpRecallView.refresh();
        vscode.window.showInformationMessage("Sybil: token saved.");
      }
    }),

    vscode.commands.registerCommand("sybil.setEndpoint", async () => {
      const endpoint = await vscode.window.showInputBox({
        prompt: "SybilKB MCP endpoint URL (e.g. http://your-sybilkb-host:8053/mcp)",
        value: config.getEndpoint() ?? "",
        ignoreFocusOut: true,
      });
      if (endpoint) {
        await config.setEndpoint(endpoint);
        mcp.disconnect();
        setupView.refresh();
        taskBoardView.refresh();
        qualityGateView.refresh();
        docsSearchView.refresh();
        dcpRecallView.refresh();
        vscode.window.showInformationMessage("Sybil: endpoint saved.");
      }
    }),

    // Split from a single "Select Project" command (2026-09-26 correction —
    // that command's FIRST prompt actually asked for owner_id, not a
    // project, which misled anyone reading the button label). Now one
    // button per field, matching setEndpoint/setToken above.
    vscode.commands.registerCommand("sybil.setOwnerId", async () => {
      const ownerId = await vscode.window.showInputBox({
        prompt: "Your Portal user_id (owner_id) — shown alongside your token in Portal",
        value: config.getOwnerId() ?? "",
        ignoreFocusOut: true,
      });
      if (ownerId) {
        await config.setOwnerId(ownerId);
        setupView.refresh();
        taskBoardView.refresh();
        qualityGateView.refresh();
        docsSearchView.refresh();
        dcpRecallView.refresh();
        vscode.window.showInformationMessage("Sybil: user ID saved.");
      }
    }),

    vscode.commands.registerCommand("sybil.setProjectId", async () => {
      const projectId = await vscode.window.showInputBox({
        prompt: "Project key (from Portal's Projects list, case-sensitive)",
        value: config.getProjectId() ?? "",
        ignoreFocusOut: true,
      });
      if (projectId) {
        await config.setProjectId(projectId);
        setupView.refresh();
        taskBoardView.refresh();
        qualityGateView.refresh();
        docsSearchView.refresh();
        dcpRecallView.refresh();
        mcp.ensureSonarqubeIdentity();
        onboardProjectIntegrations(mcp, config, context);
        vscode.window.showInformationMessage(`Sybil: now working on project "${projectId}".`);
      }
    }),

    vscode.commands.registerCommand("sybil.addPlaywrightMcp", async () => {
      try {
        const result = await addPlaywrightMcp();
        vscode.window.showInformationMessage(
          result === "added"
            ? "Sybil: added Playwright MCP to .mcp.json (headless chromium)."
            : "Sybil: .mcp.json already has a \"playwright\" entry — left untouched."
        );
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : "Unknown error adding Playwright MCP.");
      }
    }),

    vscode.commands.registerCommand("sybil.cartographerPushCurrentFile", async () => {
      await extractAndPushCurrentFile(context, mcp);
    })
  );
}

export function deactivate(): void {
  // VS Code disposes everything in context.subscriptions automatically.
}
