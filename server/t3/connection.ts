// Low-level MCP connection to a T3 environment. Knows about transport and auth,
// nothing about rooms. The adapter (adapter.ts) shapes tool calls on top of this.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { FileOAuthProvider } from "./auth.js";

export type ConnectionState =
  | { kind: "disconnected"; detail?: string }
  | { kind: "connecting" }
  | { kind: "needs_auth"; authorizationUrl: string | null }
  | { kind: "connected"; serverName: string; serverVersion: string }
  | { kind: "error"; detail: string };

export class T3ToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string,
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
  }
}

/** Resolve the T3 MCP URL: explicit env, else the running server's runtime file. */
export function resolveT3McpUrl(): string {
  if (process.env.T3_MCP_URL) return process.env.T3_MCP_URL;
  const home = process.env.T3CODE_HOME ?? path.join(os.homedir(), ".t3");
  try {
    const rt = JSON.parse(fs.readFileSync(path.join(home, "userdata", "server-runtime.json"), "utf8"));
    if (typeof rt.origin === "string") return `${rt.origin}/mcp`;
  } catch {
    /* fall through */
  }
  return "http://127.0.0.1:3773/mcp";
}

export class T3Connection {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  readonly auth: FileOAuthProvider;
  state: ConnectionState = { kind: "disconnected" };
  onState: (s: ConnectionState) => void = () => {};

  constructor(
    readonly mcpUrl: string,
    credentialsFile: string,
    callbackUrl: string,
  ) {
    this.auth = new FileOAuthProvider(credentialsFile, mcpUrl, callbackUrl, (url) =>
      this.setState({ kind: "needs_auth", authorizationUrl: url.toString() }),
    );
  }

  private setState(s: ConnectionState) {
    this.state = s;
    this.onState(s);
  }

  private newTransport() {
    return new StreamableHTTPClientTransport(new URL(this.mcpUrl), { authProvider: this.auth });
  }

  async connect(): Promise<ConnectionState> {
    await this.close();
    this.setState({ kind: "connecting" });
    const client = new Client({ name: "team-room", version: "0.1.0" });
    const transport = this.newTransport();
    try {
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      const info = client.getServerVersion();
      this.setState({
        kind: "connected",
        serverName: info?.name ?? "unknown",
        serverVersion: info?.version ?? "unknown",
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        // redirectToAuthorization already moved us to needs_auth.
        if (this.state.kind !== "needs_auth")
          this.setState({ kind: "needs_auth", authorizationUrl: this.auth.pendingAuthorizationUrl() });
      } else {
        this.setState({ kind: "error", detail: describeError(err) });
      }
    }
    return this.state;
  }

  /** Complete the OAuth redirect, then connect. */
  async finishAuth(code: string) {
    const t = this.newTransport();
    await t.finishAuth(code);
    return this.connect();
  }

  async close() {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.transport = null;
  }

  async listTools() {
    if (!this.client) throw new Error("Not connected to T3");
    return (await this.client.listTools()).tools;
  }

  /**
   * Call a T3 MCP tool. T3 returns typed failures as tool results
   * (failureMode "return"), so isError results become T3ToolError.
   */
  async call<T = any>(tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    if (!this.client) throw new T3ToolError(tool, "not_connected", "Not connected to T3");
    let res;
    try {
      res = await this.client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (err) {
      if (err instanceof UnauthorizedError || /401|unauthori[sz]ed|invalid_token/i.test(String(err))) {
        this.setState({ kind: "needs_auth", authorizationUrl: this.auth.pendingAuthorizationUrl() });
        throw new T3ToolError(tool, "auth_expired", "T3 sign-in expired or was revoked. Reconnect to T3.");
      }
      throw new T3ToolError(tool, "transport_error", describeError(err));
    }
    const payload = extractPayload(res);
    if (res.isError) {
      // T3 returns { _tag: "OrchestratorMcpFailure", code, message }.
      const code = (payload as any)?.code || (payload as any)?._tag || "tool_error";
      const message =
        (payload as any)?.message ?? (payload as any)?.detail ?? (typeof payload === "string" ? payload : JSON.stringify(payload));
      throw new T3ToolError(tool, String(code), String(message), payload);
    }
    return payload as T;
  }
}

function extractPayload(res: any): unknown {
  if (res.structuredContent !== undefined) return res.structuredContent;
  const text = (res.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as any).cause;
    if (cause?.code === "ECONNREFUSED") return "T3 server is not reachable (connection refused). Is T3 Code running?";
    return err.message;
  }
  return String(err);
}
