import * as vscode from "vscode";
import { SybilConfig } from "./config";
import { SybilMcpClient } from "./mcpClient";
import { SetupViewProvider } from "./views/setupView";
import { TaskBoardViewProvider } from "./views/taskBoardView";
import { StubViewProvider } from "./views/stubView";

export function activate(context: vscode.ExtensionContext): void {
  const config = new SybilConfig(context);
  const mcp = new SybilMcpClient(config);

  const setupView = new SetupViewProvider(context, config, mcp);
  const taskBoardView = new TaskBoardViewProvider(context, mcp);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("sybil.setup", setupView),
    vscode.window.registerWebviewViewProvider("sybil.taskBoard", taskBoardView),
    // Not built yet — placeholders so the sidebar isn't broken while these
    // land incrementally (see vscode-sybil README, "Roadmap").
    vscode.window.registerWebviewViewProvider(
      "sybil.moduleBrowser",
      new StubViewProvider("Module Browser — coming next. Will wrap sybil_search / sybil_get_module.")
    ),
    vscode.window.registerWebviewViewProvider(
      "sybil.dcpRecall",
      new StubViewProvider("DCP Recall — coming next. Will wrap sybil_recall.")
    ),
    vscode.window.registerWebviewViewProvider(
      "sybil.qualityGate",
      new StubViewProvider("Quality Gate — coming next. Will wrap sybil_get_quality_report, hidden for projects with no gate configured.")
    ),

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
        vscode.window.showInformationMessage("Sybil: endpoint saved.");
      }
    }),

    vscode.commands.registerCommand("sybil.selectProject", async () => {
      const ownerId = await vscode.window.showInputBox({
        prompt: "Your Portal user_id (owner_id) — shown alongside your token in Portal",
        value: config.getOwnerId() ?? "",
        ignoreFocusOut: true,
      });
      if (!ownerId) {
        return;
      }
      await config.setOwnerId(ownerId);

      const projectId = await vscode.window.showInputBox({
        prompt: "Project key (from Portal's Projects list, case-sensitive)",
        value: config.getProjectId() ?? "",
        ignoreFocusOut: true,
      });
      if (projectId) {
        await config.setProjectId(projectId);
        setupView.refresh();
        vscode.window.showInformationMessage(`Sybil: now working on project "${projectId}".`);
      }
    })
  );
}

export function deactivate(): void {
  // VS Code disposes everything in context.subscriptions automatically.
}
