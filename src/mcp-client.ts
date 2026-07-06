import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import crypto from "node:crypto";
import { config } from "./config.js";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

let client: Client | null = null;
let cachedPartnerToken: string | null = null;

async function getPartnerToken(): Promise<string> {
  if (cachedPartnerToken) return cachedPartnerToken;

  const { apiKey, apiSecret, mcpUrl } = config.routestack;
  if (!apiSecret) return apiKey;

  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const hmac = crypto
    .createHmac("sha256", apiSecret)
    .update(`${apiKey}:${ts}:${nonce}`)
    .digest("base64url");

  const base = new URL(mcpUrl);
  const tokenUrl = new URL("/mcp/auth/partner-token", base.origin);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey, hmac, timestamp: ts, nonce }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Partner-token request failed (${res.status}): ${text}`);

  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(`Partner-token response was not JSON: ${text}`); }

  const token =
    (data as { token?: string }).token ??
    (data as { accessToken?: string }).accessToken ??
    (data as { partnerToken?: string }).partnerToken ??
    (data as { jwt?: string }).jwt;

  if (!token || typeof token !== "string") throw new Error(`Partner-token response missing token field: ${text}`);

  cachedPartnerToken = token;
  return token;
}

export async function connectMcp(): Promise<void> {
  const { mcpUrl } = config.routestack;
  const url = new URL(mcpUrl);
  const token = await getPartnerToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

  client = new Client({ name: "nonrev-concierge", version: "0.1.0" });

  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTransportMismatch =
      message.includes("404") || message.includes("405") ||
      message.includes("Not Found") || message.includes("Method Not Allowed");

    if (!isTransportMismatch) throw err;

    await client.close().catch(() => {});
    client = new Client({ name: "nonrev-concierge", version: "0.1.0" });
    await client.connect(new SSEClientTransport(url, { requestInit: { headers } }));
  }
}

export async function listTools(): Promise<McpTool[]> {
  if (!client) throw new Error("MCP client not connected");

  const allTools: McpTool[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listTools({ cursor });
    allTools.push(
      ...result.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      })),
    );
    cursor = result.nextCursor;
  } while (cursor);

  return allTools;
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  if (!client) throw new Error("MCP client not connected");
  const result = await client.callTool({ name, arguments: args });
  return {
    content: (result.content ?? []) as McpToolResult["content"],
    isError: result.isError as boolean | undefined,
  };
}

export async function disconnectMcp(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
