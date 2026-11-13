// OAuth client for T3's MCP endpoint (standard MCP authorization: dynamic client
// registration + PKCE, public client). Credentials live only on disk in data/
// with 0600 permissions; they are never sent to the browser or logged.
import fs from "node:fs";
import path from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

type Stored = {
  serverUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens & { obtainedAt?: number };
  codeVerifier?: string;
  pendingAuthUrl?: string;
};

export const T3_SCOPES = "orchestration:read orchestration:operate";

export class FileOAuthProvider implements OAuthClientProvider {
  private data: Stored;

  constructor(
    private readonly file: string,
    private readonly serverUrl: string,
    private readonly callbackUrl: string,
    private readonly onAuthorizationUrl: (url: URL) => void = () => {},
  ) {
    this.data = this.load();
    // A different T3 environment invalidates everything we stored.
    if (this.data.serverUrl && this.data.serverUrl !== serverUrl) this.data = {};
    this.data.serverUrl = serverUrl;
  }

  private load(): Stored {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Stored;
    } catch {
      return {};
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get redirectUrl() {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Team Room",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: T3_SCOPES,
    };
  }

  clientInformation() {
    return this.data.client;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.data.client = info;
    this.save();
  }
  tokens() {
    return this.data.tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.data.tokens = { ...tokens, obtainedAt: Date.now() };
    delete this.data.pendingAuthUrl;
    this.save();
  }
  redirectToAuthorization(url: URL) {
    this.data.pendingAuthUrl = url.toString();
    this.save();
    this.onAuthorizationUrl(url);
  }
  saveCodeVerifier(v: string) {
    this.data.codeVerifier = v;
    this.save();
  }
  codeVerifier() {
    if (!this.data.codeVerifier) throw new Error("No PKCE verifier saved; restart sign-in.");
    return this.data.codeVerifier;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all") this.data = { serverUrl: this.serverUrl };
    if (scope === "client") delete this.data.client;
    if (scope === "tokens") delete this.data.tokens;
    if (scope === "verifier") delete this.data.codeVerifier;
    this.save();
  }

  hasTokens() {
    return Boolean(this.data.tokens?.access_token);
  }
  pendingAuthorizationUrl() {
    return this.data.pendingAuthUrl ?? null;
  }
  tokenExpiry(): number | null {
    const t = this.data.tokens;
    if (!t?.expires_in || !t.obtainedAt) return null;
    return t.obtainedAt + t.expires_in * 1000;
  }
}
