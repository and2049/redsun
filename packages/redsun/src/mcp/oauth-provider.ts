import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { McpAuth } from "./auth"
import { Log } from "../util/log"

const log = Log.create({ service: "mcp.oauth" })

const OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string
}

export function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  try {
    const url = new URL(redirectUri)
    return {
      port: url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80,
      path: url.pathname || OAUTH_CALLBACK_PATH,
    }
  } catch {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
}

export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    protected mcpName: string,
    protected serverUrl: string,
    protected config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
  ) {}

  get redirectUrl(): string {
    if (this.config.redirectUri) return this.config.redirectUri
    return `http://127.0.0.1:${this.config.callbackPort ?? OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Redsun",
      client_uri: "https://redsun.local",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    // Check config first (pre-registered client)
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }
    }

    // Check stored client info (from dynamic registration)
    // Use getForUrl to validate credentials are for the current server URL
    const entry = await McpAuth.getForUrl(this.mcpName, this.serverUrl)
    if (entry?.clientInfo) {
      // Check if client secret has expired
      if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        log.info("client secret expired, need to re-register", { mcpName: this.mcpName })
        return undefined
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
      }
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await McpAuth.updateClientInfo(
      this.mcpName,
      {
        clientId: info.client_id,
        clientSecret: info.client_secret,
        clientIdIssuedAt: info.client_id_issued_at,
        clientSecretExpiresAt: info.client_secret_expires_at,
      },
      this.serverUrl,
    )
    log.info("saved dynamically registered client", {
      mcpName: this.mcpName,
      clientId: info.client_id,
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Use getForUrl to validate tokens are for the current server URL
    const entry = await McpAuth.getForUrl(this.mcpName, this.serverUrl)
    if (!entry?.tokens) return undefined

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await McpAuth.updateTokens(
      this.mcpName,
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
        scope: tokens.scope,
      },
      this.serverUrl,
    )
    log.info("saved oauth tokens", { mcpName: this.mcpName })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info("redirecting to authorization", { mcpName: this.mcpName, url: authorizationUrl.toString() })
    await this.callbacks.onRedirect(authorizationUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await McpAuth.updateCodeVerifier(this.mcpName, codeVerifier)
  }

  async codeVerifier(): Promise<string> {
    const entry = await McpAuth.get(this.mcpName)
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.mcpName}`)
    }
    return entry.codeVerifier
  }

  async saveState(state: string): Promise<void> {
    await McpAuth.updateOAuthState(this.mcpName, state)
  }

  async state(): Promise<string> {
    const entry = await McpAuth.get(this.mcpName)
    if (!entry?.oauthState) {
      throw new Error(`No OAuth state saved for MCP server: ${this.mcpName}`)
    }
    return entry.oauthState
  }
}

export class McpOAuthPendingProvider extends McpOAuthProvider {
  private pendingClientInfo?: OAuthClientInformationFull
  private pendingTokens?: OAuthTokens

  override async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (!this.config.clientId) return this.pendingClientInfo
    return {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    }
  }

  override async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.pendingClientInfo = info
  }

  override async tokens(): Promise<OAuthTokens | undefined> {
    return this.pendingTokens
  }

  override async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.pendingTokens = tokens
  }

  async commit(): Promise<void> {
    if (!this.pendingTokens) return
    await McpAuth.set(
      this.mcpName,
      {
        tokens: {
          accessToken: this.pendingTokens.access_token,
          refreshToken: this.pendingTokens.refresh_token,
          expiresAt: this.pendingTokens.expires_in ? Date.now() / 1000 + this.pendingTokens.expires_in : undefined,
          scope: this.pendingTokens.scope,
        },
        clientInfo:
          this.pendingClientInfo && !this.config.clientId
            ? {
                clientId: this.pendingClientInfo.client_id,
                clientSecret: this.pendingClientInfo.client_secret,
                clientIdIssuedAt: this.pendingClientInfo.client_id_issued_at,
                clientSecretExpiresAt: this.pendingClientInfo.client_secret_expires_at,
              }
            : undefined,
      },
      this.serverUrl,
    )
  }
}

export { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }
