import { describe, expect, test } from "bun:test"
import { OpenAIModels } from "@opencode/core/plugin/provider/openai-models"

describe("OpenAIModels", () => {
  test("reads each model's default and maximum input window from the ChatGPT catalog", () => {
    const windows = OpenAIModels.parseWindows({
      models: [
        { slug: "gpt-6-astra", context_window: 272_000, max_context_window: 872_000, other: true },
        { slug: "gpt-5.5", context_window: 272_000, max_context_window: 272_000 },
        { slug: "max-only", max_context_window: 400_000 },
        { slug: "unsized" },
      ],
    })
    expect([...windows]).toEqual([
      ["gpt-6-astra", { default: 272_000, max: 872_000 }],
      ["gpt-5.5", { default: 272_000, max: 272_000 }],
      ["max-only", { default: 400_000, max: 400_000 }],
    ])
    expect(() => OpenAIModels.parseWindows({ data: [] })).toThrow()
  })

  test("sizes the input window by setting and keeps the output headroom on top", () => {
    const astra = { default: 272_000, max: 872_000 }
    expect(OpenAIModels.limit(astra, "default")).toEqual({ context: 400_000, input: 272_000 })
    expect(OpenAIModels.limit(astra, "max")).toEqual({ context: 1_000_000, input: 872_000 })
    expect(OpenAIModels.limit({ default: 272_000 }, "max")).toEqual({ context: 400_000, input: 272_000 })
    // Unlisted models keep the window Codex falls back to.
    expect(OpenAIModels.limit(undefined, "max")).toEqual({ context: 400_000, input: 272_000 })
  })

  test("requests the catalog as a supported Codex version with the account's credentials", async () => {
    const original = globalThis.fetch
    const requests: { url: string; headers: Headers }[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: new Headers(init.headers) })
      return Response.json({ models: [{ slug: "gpt-6-astra", context_window: 272_000 }] })
    }) as typeof fetch
    try {
      const windows = await OpenAIModels.readWindows(
        {
          type: "oauth",
          methodID: "chatgpt-browser",
          access: "token",
          refresh: "refresh",
          expires: 0,
          metadata: { accountID: "acct_1" },
        } as never,
        "https://chatgpt.com/backend-api/codex",
        AbortSignal.timeout(1_000),
      )
      expect(windows.get("gpt-6-astra")).toEqual({ default: 272_000 })
      expect(requests[0]!.url).toBe(
        `https://chatgpt.com/backend-api/codex/models?client_version=${OpenAIModels.CLIENT_VERSION}`,
      )
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer token")
      expect(requests[0]!.headers.get("chatgpt-account-id")).toBe("acct_1")
    } finally {
      globalThis.fetch = original
    }
  })
})
