import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"

const xdgRoot = path.join(os.tmpdir(), "redsun-oauth-provider-test-" + Math.random().toString(36).slice(2))
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache")
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config")
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data")
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state")

const { McpAuth } = await import("../../src/mcp/auth")
const { McpOAuthPendingProvider } = await import("../../src/mcp/oauth-provider")
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
