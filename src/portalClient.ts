/**
 * Thin client for Portal's bearer-auth-capable self-service endpoints
 * (Portal/routers/profile.py: _current_user_id_or_bearer). Used only during
 * setup/auto-configure — SybilKB itself (mcpClient.ts) is the actual
 * runtime integration surface, this is just onboarding plumbing.
 */

export interface SybilInfo {
  user_id: string;
  username: string;
  project_keys: string[];
}

export interface McpJsonResponse {
  mcpServers: {
    "sybil-kb": {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
  };
}

async function getJson<T>(portalUrl: string, path: string, token: string): Promise<T> {
  const res = await fetch(`${trimSlash(portalUrl)}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Portal ${path} returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as T;
}

export async function fetchSybilInfo(portalUrl: string, token: string): Promise<SybilInfo> {
  return getJson<SybilInfo>(portalUrl, "/api/user/sybil-info", token);
}

export async function fetchMcpJson(portalUrl: string, token: string): Promise<McpJsonResponse> {
  return getJson<McpJsonResponse>(portalUrl, "/api/user/sybil-mcp-json", token);
}

export async function fetchClaudeMd(portalUrl: string, token: string): Promise<string> {
  const res = await fetch(`${trimSlash(portalUrl)}/api/user/sybil-claude-md`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Portal /sybil-claude-md returned ${res.status}: ${await safeText(res)}`);
  }
  return res.text();
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(no body)";
  }
}
