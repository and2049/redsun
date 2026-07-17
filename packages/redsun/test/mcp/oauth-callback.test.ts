import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"

const xdgRoot = path.join(os.tmpdir(), "redsun-oauth-test-" + Math.random().toString(36).slice(2))
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache")
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config")
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data")
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state")

const { McpOAuthCallback, OAUTH_CALLBACK_HOST } = await import("../../src/mcp/oauth-callback")
const { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT } = await import("../../src/mcp/oauth-provider")
const callbackUrl = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`

describe("McpOAuthCallback", () => {
  test("binds callbacks to IPv4 loopback", () => {
    expect(OAUTH_CALLBACK_HOST).toBe("127.0.0.1")
  })

  afterEach(async () => {
    await McpOAuthCallback.stop()
  })

  test("escapes provider error markup in callback HTML", async () => {
    await McpOAuthCallback.ensureRunning()

    const error = `<script>alert("xss" & 'more')</script>`
    const response = await fetch(
      `${callbackUrl}?state=test&error=access_denied&error_description=${encodeURIComponent(error)}`,
    )
    const body = await response.text()

    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(body).toContain("&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;more&#39;)&lt;/script&gt;")
    expect(body).not.toContain(error)
  })

  test("keeps normal provider errors readable", async () => {
    await McpOAuthCallback.ensureRunning()

    const response = await fetch(
      `${callbackUrl}?state=test&error=access_denied&error_description=${encodeURIComponent("The user denied access")}`,
    )

    expect(await response.text()).toContain('<div class="error">The user denied access</div>')
  })

  test("stops after the callback completes", async () => {
    await McpOAuthCallback.ensureRunning()
    const callback = McpOAuthCallback.waitForCallback("success")

    const response = await fetch(`${callbackUrl}?code=code&state=success`)

    expect(response.status).toBe(200)
    expect(await callback).toBe("code")
    expect(McpOAuthCallback.isRunning()).toBe(false)
  })

  test("stops after cancellation by MCP name", async () => {
    await McpOAuthCallback.ensureRunning()
    const callback = McpOAuthCallback.waitForCallback("cancel-state", "test-server")

    McpOAuthCallback.cancelPending("test-server")

    await expect(callback).rejects.toThrow("Authorization cancelled")
    expect(McpOAuthCallback.isRunning()).toBe(false)
  })
})
