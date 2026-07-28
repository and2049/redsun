import path from "node:path"
import { describe, expect, test } from "bun:test"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"

describe("mcp session recovery", () => {
  test("reinitializes and retries once after a session-bound POST returns 404", async () => {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../fixture/mcp-session-recovery.ts")], {
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      Bun.readableStreamToText(child.stdout),
      Bun.readableStreamToText(child.stderr),
    ])

    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual([
      { method: "initialize", session: null },
      { method: "notifications/initialized", session: "expired" },
      { method: "ping", session: "expired" },
      { method: "initialize", session: null },
      { method: "notifications/initialized", session: "replacement" },
      { method: "ping", session: "replacement" },
    ])
  })

  test("coalesces concurrent expired OAuth refreshes", async () => {
    let auth = { type: "oauth" as const, refresh: "refresh-old", access: "", expires: 0 }
    const authUpdates: unknown[] = []
    let resolveRefresh: (() => void) | undefined
    const refreshReady = new Promise<void>((resolve) => (resolveRefresh = resolve))
    let refreshRequests = 0
    const apiRequests: Array<{ authorization: string | null; accountId: string | null }> = []
    const jwt = (payload: object) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
      return `eyJhbGciOiJub25lIn0.${encoded}.sig`
    }

    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/oauth/token") {
          refreshRequests++
          await refreshReady
          return Response.json({
            id_token: jwt({ chatgpt_account_id: "acc-123" }),
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          })
        }
        if (url.pathname === "/backend-api/codex/responses") {
          apiRequests.push({
            authorization: request.headers.get("authorization"),
            accountId: request.headers.get("ChatGPT-Account-Id"),
          })
          return new Response("{}")
        }
        return new Response("unexpected request", { status: 500 })
      },
    })
    const hooks = await CodexAuthPlugin(
      {
        client: {
          auth: {
            async set(input: { body: { refresh: string; access: string; expires: number; accountId?: string } }) {
              authUpdates.push(input)
              auth = { type: "oauth", ...input.body }
            },
          },
        } as never,
        project: {} as never,
        directory: "",
        worktree: "",
        experimental_workspace: { register() {} },
        serverUrl: new URL("https://example.com"),
        $: {} as never,
      },
      {
        issuer: server.url.origin,
        codexApiEndpoint: new URL("/backend-api/codex/responses", server.url).toString(),
      },
    )
    const loaded = await hooks.auth!.loader!(async () => auth as never, {} as never)
    const first = loaded.fetch!("https://api.openai.com/v1/responses")
    const second = loaded.fetch!("https://api.openai.com/v1/responses")
    for (let i = 0; i < 100 && refreshRequests === 0; i++) await Bun.sleep(1)
    expect(refreshRequests).toBe(1)
    expect(apiRequests).toHaveLength(0)
    resolveRefresh!()
    await Promise.all([first, second])
    expect(authUpdates).toHaveLength(1)
    const update = authUpdates[0] as { body: { refresh: string; access: string; expires: number; accountId?: string } }
    expect(update.body.refresh).toBe("refresh-new")
    expect(update.body.access).toBe("access-new")
    expect(update.body.expires).toBeGreaterThan(Date.now())
    expect(update.body.accountId).toBe("acc-123")
    expect(apiRequests).toEqual([
      { authorization: "Bearer access-new", accountId: "acc-123" },
      { authorization: "Bearer access-new", accountId: "acc-123" },
    ])
  })
})
