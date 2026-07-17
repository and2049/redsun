import { afterEach, expect, test } from "bun:test"
import { OpenAICodexOAuth } from "../../src/provider/openai-codex-oauth"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import { ProviderAuth } from "../../src/provider/auth"

function jwt(payload: unknown) {
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".")
}

afterEach(async () => {
  await Auth.remove("openai").catch(() => {})
})

test("buildAuthorizeUrl includes OpenAI Codex OAuth parameters", async () => {
  const url = new URL(
    OpenAICodexOAuth.buildAuthorizeUrl({
      redirectURI: "http://localhost:1455/auth/callback",
      pkce: {
        verifier: "verifier",
        challenge: "challenge",
      },
      state: "state",
    }),
  )

  expect(url.origin).toBe("https://auth.openai.com")
  expect(url.pathname).toBe("/oauth/authorize")
  expect(url.searchParams.get("client_id")).toBe(OpenAICodexOAuth.CLIENT_ID)
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
  expect(url.searchParams.get("code_challenge")).toBe("challenge")
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true")
  expect(url.searchParams.get("originator")).toBe("redsun")
})

test("OpenAI OAuth model policy filters unsupported aliases and pro modes", () => {
  const model = (id: string, options: Record<string, any> = {}) => ({ api: { id }, options })
  expect(OpenAICodexOAuth.supportsModel(model("gpt-5.4"))).toBe(true)
  expect(OpenAICodexOAuth.supportsModel(model("gpt-5.6-sol"))).toBe(true)
  expect(OpenAICodexOAuth.supportsModel(model("gpt-5.6"))).toBe(false)
  expect(OpenAICodexOAuth.supportsModel(model("gpt-5.5-pro"))).toBe(false)
  expect(OpenAICodexOAuth.supportsModel(model("gpt-5.4", { reasoningMode: "pro" }))).toBe(false)
})

test("OpenAI OAuth applies Codex context limits to GPT 5.5 and 5.6 families", () => {
  const limit = { context: 1_050_000, input: 922_000, output: 128_000 }
  expect(OpenAICodexOAuth.contextLimits({ id: "gpt-5.5", limit })).toEqual({
    context: 400_000,
    input: 272_000,
    output: 128_000,
  })
  expect(OpenAICodexOAuth.contextLimits({ id: "gpt-5.6-sol", limit })).toEqual({
    context: 500_000,
    input: 372_000,
    output: 128_000,
  })
  expect(OpenAICodexOAuth.contextLimits({ id: "gpt-5.4", limit })).toBe(limit)
})

test("extractAccountId supports current OpenAI JWT claim shapes", () => {
  expect(
    OpenAICodexOAuth.extractAccountId({
      access_token: jwt({
        chatgpt_account_id: "top-level",
      }),
    }),
  ).toBe("top-level")

  expect(
    OpenAICodexOAuth.extractAccountId({
      access_token: jwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "nested",
        },
      }),
    }),
  ).toBe("nested")
})

test("normalizeCodexRequestBody forces stateless Codex-compatible input", () => {
  const result = OpenAICodexOAuth.normalizeCodexRequestBody({
    store: true,
    include: ["foo"],
    input: [
      { type: "message", id: "msg_1", role: "user" },
      { type: "item_reference", id: "ref_1" },
      { type: "function_call", id: "call_1", name: "bash" },
    ],
  })

  expect(result.store).toBe(false)
  expect(result.include).toEqual(["foo", "reasoning.encrypted_content"])
  expect(result.input).toEqual([
    { type: "message", role: "user" },
    { type: "function_call", name: "bash" },
  ])
})

test("createFetch rewrites responses requests and replaces API auth headers", async () => {
  let seenURL = ""
  let seenInit: RequestInit | undefined
  const codexFetch = OpenAICodexOAuth.createFetch({
    getAuth: async () => ({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-id",
    }),
    setAuth: async () => {},
    fetch: (async (input, init) => {
      seenURL = input.toString()
      seenInit = init
      return new Response("{}", { status: 200 })
    }) as typeof fetch,
  })

  await codexFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer api-key",
      "x-api-key": "api-key",
    },
    body: JSON.stringify({
      store: true,
      input: [{ type: "message", id: "msg_1", role: "user" }],
    }),
  })

  const headers = new Headers(seenInit?.headers)
  expect(seenURL).toBe(OpenAICodexOAuth.CODEX_API_ENDPOINT)
  expect(headers.get("authorization")).toBe("Bearer access-token")
  expect(headers.get("x-api-key")).toBeNull()
  expect(headers.get("ChatGPT-Account-Id")).toBe("account-id")
  expect(JSON.parse(seenInit?.body as string)).toMatchObject({
    store: false,
    include: ["reasoning.encrypted_content"],
    input: [{ type: "message", role: "user" }],
  })
})

test("createFetch preserves a Request method and body while rewriting", async () => {
  let seenURL = ""
  let seenInit: RequestInit | undefined
  const codexFetch = OpenAICodexOAuth.createFetch({
    getAuth: async () => ({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    }),
    setAuth: async () => {},
    fetch: (async (input, init) => {
      seenURL = input.toString()
      seenInit = init
      return new Response("{}", { status: 200 })
    }) as typeof fetch,
  })

  await codexFetch(
    new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer api-key", "Content-Type": "application/json" },
      body: JSON.stringify({ store: true, input: [{ type: "message", id: "msg_1", role: "user" }] }),
    }),
  )

  expect(seenURL).toBe(OpenAICodexOAuth.CODEX_API_ENDPOINT)
  expect(seenInit?.method).toBe("POST")
  expect(JSON.parse(seenInit?.body as string)).toMatchObject({
    store: false,
    include: ["reasoning.encrypted_content"],
    input: [{ type: "message", role: "user" }],
  })
})

test("createFetch refreshes expired OAuth credentials and stores account ID", async () => {
  const originalFetch = globalThis.fetch
  const refreshedAccess = jwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "refreshed-account",
    },
  })
  let stored: Auth.Info | undefined
  let requestCount = 0

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString()
    if (url === "https://auth.openai.com/oauth/token") {
      return new Response(
        JSON.stringify({
          access_token: refreshedAccess,
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      )
    }
    requestCount++
    return new Response("{}", { status: 200 })
  }) as typeof fetch

  try {
    const codexFetch = OpenAICodexOAuth.createFetch({
      getAuth: async () => ({
        type: "oauth",
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
      }),
      setAuth: async (auth) => {
        stored = auth
      },
    })

    await codexFetch("https://api.openai.com/v1/responses", {
      body: JSON.stringify({ input: [] }),
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(requestCount).toBe(1)
  expect(stored).toMatchObject({
    type: "oauth",
    access: refreshedAccess,
    refresh: "new-refresh",
    accountId: "refreshed-account",
  })
})

test("ProviderAuth exposes built-in OpenAI OAuth and API methods", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "redsun.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const methods = (await ProviderAuth.methods()).openai
      expect(methods.map((x: ProviderAuth.Method) => x.label)).toEqual([
        "ChatGPT Plus/Pro (browser)",
        "ChatGPT Plus/Pro (headless)",
        "API key",
      ])
    },
  })
})

test("OpenAI OAuth auth autoloads provider and zeroes visible costs", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "redsun.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
    },
  })
  await Auth.set("openai", {
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: Date.now() + 60_000,
    accountId: "account",
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers.openai).toBeDefined()
      const model = Object.values(providers.openai.models)[0]
      expect(model.cost).toEqual({
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      })
    },
  })
})

test("OpenAI API-key auth keeps normal provider key path", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(path.join(dir, "redsun.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
    },
  })
  await Auth.set("openai", {
    type: "api",
    key: "api-key",
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await Provider.list()
      expect(providers.openai).toBeDefined()
      expect(providers.openai.key).toBe("api-key")
      expect(providers.openai.options.apiKey).toBeUndefined()
      expect(providers.openai.options.fetch).toBeUndefined()
    },
  })
})
