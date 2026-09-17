import * as vscode from "vscode";

const SECRET_TOKEN_KEY = "sybil.token";
const STATE_ENDPOINT_KEY = "sybil.endpoint";
const STATE_OWNER_ID_KEY = "sybil.ownerId";
const STATE_PROJECT_ID_KEY = "sybil.projectId";
const STATE_PORTAL_URL_KEY = "sybil.portalUrl";

/**
 * All SybilKB connection state for the current workspace.
 * Token lives in SecretStorage (OS keychain); everything else is workspace
 * state so different workspaces can point at different projects/instances.
 */
export class SybilConfig {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getToken(): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_TOKEN_KEY);
  }

  async setToken(token: string): Promise<void> {
    await this.context.secrets.store(SECRET_TOKEN_KEY, token);
  }

  async clearToken(): Promise<void> {
    await this.context.secrets.delete(SECRET_TOKEN_KEY);
  }

  getEndpoint(): string | undefined {
    return this.context.workspaceState.get<string>(STATE_ENDPOINT_KEY);
  }

  async setEndpoint(endpoint: string): Promise<void> {
    await this.context.workspaceState.update(STATE_ENDPOINT_KEY, endpoint);
  }

  /** Portal base URL (e.g. http://your-portal-host:8000) — used only for auto-configure, not per-call. */
  getPortalUrl(): string | undefined {
    return this.context.workspaceState.get<string>(STATE_PORTAL_URL_KEY);
  }

  async setPortalUrl(url: string): Promise<void> {
    await this.context.workspaceState.update(STATE_PORTAL_URL_KEY, url);
  }

  getOwnerId(): string | undefined {
    return this.context.workspaceState.get<string>(STATE_OWNER_ID_KEY);
  }

  async setOwnerId(ownerId: string): Promise<void> {
    await this.context.workspaceState.update(STATE_OWNER_ID_KEY, ownerId);
  }

  getProjectId(): string | undefined {
    return this.context.workspaceState.get<string>(STATE_PROJECT_ID_KEY);
  }

  async setProjectId(projectId: string): Promise<void> {
    await this.context.workspaceState.update(STATE_PROJECT_ID_KEY, projectId);
  }

  /** True once endpoint, token, owner_id, and project_id are all set. */
  async isConfigured(): Promise<boolean> {
    const token = await this.getToken();
    return Boolean(token && this.getEndpoint() && this.getOwnerId() && this.getProjectId());
  }
}
