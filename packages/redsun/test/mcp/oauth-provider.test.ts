import { describe, expect, test } from "bun:test"
import { determineScope } from "@modelcontextprotocol/sdk/client/auth.js"
import os from "os"
import path from "path"

const xdgRoot = path.join(os.tmpdir(), "redsun-oauth-provider-test-" + Math.random().toString(36).slice(2))
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache")
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config")
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data")
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state")

const { McpAuth } = await import("../../src/mcp/auth")
const { McpOAuthPendingProvider, parseRedirectUri } = await import("../../src/mcp/oauth-provider")
const serverName = "pending-provider-" + Math.random().toString(36).slice(2)

describe("McpOAuthPendingProvider", () => {
  test("does not persist tokens before commit", async () => {
    const provider = new McpOAuthPendingProvider(
      serverName,
      "https://example.com/mcp",
      {},
      {
        onRedirect() {},
      },
    )

    await provider.saveClientInformation({
      client_id: "client",
      client_secret: "secret",
      redirect_uris: ["http://127.0.0.1/callback"],
    })
    await provider.saveTokens({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 60 })

    expect(await McpAuth.get(serverName)).toBeUndefined()

    await provider.commit()

    const stored = await McpAuth.getForUrl(serverName, "https://example.com/mcp")
    expect(stored?.tokens?.accessToken).toBe("access")
    expect(stored?.tokens?.refreshToken).toBe("refresh")
    expect(stored?.clientInfo?.clientId).toBe("client")

    await McpAuth.remove(serverName)
  })
})

describe("MCP OAuth scope selection", () => {
  test("preserves configured scopes in client metadata", () => {
    const provider = new McpOAuthPendingProvider(serverName, "https://example.com/mcp", { scope: "resource.read" }, {
      onRedirect() {},
    })

    expect(provider.clientMetadata.scope).toBe("resource.read")
  })

  test("requests refresh tokens only when the authorization server supports them", () => {
    const clientMetadata = new McpOAuthPendingProvider(serverName, "https://example.com/mcp", {}, {
      onRedirect() {},
    }).clientMetadata
    const authServerMetadata = (scopes_supported: string[]) => ({
      issuer: "https://example.com",
      authorization_endpoint: "https://example.com/authorize",
      token_endpoint: "https://example.com/token",
      response_types_supported: ["code"],
      scopes_supported,
    })

    expect(
      determineScope({
        resourceMetadata: { resource: "https://example.com/mcp", scopes_supported: ["resource.read"] },
        authServerMetadata: authServerMetadata(["resource.read", "offline_access"]),
        clientMetadata,
      }),
    ).toBe("resource.read offline_access")
    expect(
      determineScope({
        resourceMetadata: { resource: "https://example.com/mcp", scopes_supported: ["resource.read"] },
        authServerMetadata: authServerMetadata(["resource.read"]),
        clientMetadata,
      }),
    ).toBe("resource.read")
  })

  test("uses configured callback ports and redirect URIs", () => {
    const portProvider = new McpOAuthPendingProvider(serverName, "https://example.com/mcp", { callbackPort: 23456 }, {
      onRedirect() {},
    })
    const redirectProvider = new McpOAuthPendingProvider(
      serverName,
      "https://example.com/mcp",
      { callbackPort: 23456, redirectUri: "http://127.0.0.1:34567/custom/callback" },
      { onRedirect() {} },
    )

    expect(portProvider.redirectUrl).toBe("http://127.0.0.1:23456/mcp/oauth/callback")
    expect(redirectProvider.redirectUrl).toBe("http://127.0.0.1:34567/custom/callback")
    expect(parseRedirectUri(redirectProvider.redirectUrl)).toEqual({ port: 34567, path: "/custom/callback" })
  })
})
