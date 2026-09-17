import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SybilConfig } from "./config";

/**
 * Thin MCP client wrapper for talking to SybilKB, mirroring exactly how
 * Claude Code connects via .mcp.json (Streamable HTTP + Authorization: Bearer).
 * No SybilKB-specific HTTP routes exist for this extension to call instead —
 * this IS the integration surface, same protocol, same auth, same server.
 */
export class SybilMcpClient {
  private client: Client | undefined;

  constructor(private readonly config: SybilConfig) {}

  private async connect(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    const token = await this.config.getToken();
    const endpoint = this.config.getEndpoint();
    if (!token || !endpoint) {
      throw new Error("Sybil is not configured yet — run 'Sybil: Set SybilKB Endpoint URL' and 'Sybil: Set SybilKB Access Token' first.");
    }

    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });

    const client = new Client({ name: "vscode-sybil", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  /** Reset the connection — call after the token/endpoint changes. */
  disconnect(): void {
    this.client = undefined;
  }

  /**
   * Call a SybilKB tool, auto-injecting project_id/owner_id from workspace
   * config so every view doesn't have to thread them through separately.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const client = await this.connect();
    const projectId = this.config.getProjectId();
    const ownerId = this.config.getOwnerId();
    if (!projectId || !ownerId) {
      throw new Error("No project selected — run 'Sybil: Select Project' first.");
    }

    const result = await client.callTool({
      name,
      arguments: { project_id: projectId, owner_id: ownerId, ...args },
    });
    return result;
  }
}
