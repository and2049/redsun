import { describe, expect, it } from "bun:test"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Exit } from "effect"
import { ClaudeCodeAuth } from "@opencode-ai/core/plugin/redsun/claude-code/auth"
import type { ClaudeCodeSessions } from "@opencode-ai/core/plugin/redsun/claude-code/sessions"

const account = {
  email: "someone@example.com",
  organization: "Example",
  subscriptionType: "max",
  apiProvider: "anthropic",
  // Never displayed, and must never be stored.
  tokenSource: "oauth-token-value",
  apiKeySource: "sk-should-not-be-stored",
}

const fakeQuery = (input: {
  readonly account?: unknown
  readonly via?: "accountInfo" | "initializationResult"
  readonly fail?: boolean
  readonly hang?: boolean
}) => {
  const state = { spawned: 0, closed: 0, options: undefined as Options | undefined }
  const createQuery: ClaudeCodeSessions.CreateQuery = (call) => {
    state.spawned += 1
    state.options = call.options
    const resolve = async () => {
      if (input.fail) throw new Error("spawn failed")
      if (input.hang) return new Promise<never>(() => {})
      return input.account
    }
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKMessage>>(() => {}) }),
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      close: () => {
        state.closed += 1
      },
      ...(input.via === "initializationResult"
        ? { initializationResult: async () => ({ account: await resolve() }) }
        : { accountInfo: resolve }),
    }
  }
  return { createQuery, state }
}

const run = (createQuery: ClaudeCodeSessions.CreateQuery) =>
  Effect.runPromiseExit(ClaudeCodeAuth.probe({ createQuery, options: {} as Options }))

describe("ClaudeCodeAuth.accountMetadata", () => {
  it("keeps only the account fields worth displaying", () => {
    // The credential is a marker; anything token-shaped must not ride along in
    // metadata, which is what the connection label is derived from.
    expect(ClaudeCodeAuth.accountMetadata(account)).toEqual({
      email: "someone@example.com",
      organization: "Example",
      subscriptionType: "max",
      apiProvider: "anthropic",
    })
  })

  it("reports nothing when the CLI describes no account", () => {
    expect(ClaudeCodeAuth.accountMetadata(undefined)).toBeUndefined()
    expect(ClaudeCodeAuth.accountMetadata({})).toBeUndefined()
    expect(ClaudeCodeAuth.accountMetadata({ tokenSource: "secret" })).toBeUndefined()
  })
})

describe("ClaudeCodeAuth.probe", () => {
  it("stores a marker credential describing the signed-in account", async () => {
    const { createQuery, state } = fakeQuery({ account })
    const exit = await run(createQuery)

    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value).toEqual({
      type: "oauth",
      methodID: ClaudeCodeAuth.METHOD_ID,
      // Redsun holds no Anthropic token: the "credential" only records that the
      // CLI is signed in.
      access: "claude-code-cli",
      refresh: "claude-code-cli",
      expires: 0,
      metadata: {
        email: "someone@example.com",
        organization: "Example",
        subscriptionType: "max",
        apiProvider: "anthropic",
      },
    })
    expect(state.closed).toBe(1)
  })

  it("never runs a turn or persists a CLI session", async () => {
    const { createQuery, state } = fakeQuery({ account })
    await run(createQuery)
    expect(state.options).toMatchObject({
      maxTurns: 1,
      allowedTools: [],
      strictMcpConfig: true,
      persistSession: false,
    })
  })

  it("falls back to the init handshake when accountInfo is absent", async () => {
    const { createQuery } = fakeQuery({ account, via: "initializationResult" })
    const exit = await run(createQuery)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value.metadata).toMatchObject({ email: "someone@example.com" })
  })

  it("reports an unsigned CLI rather than storing an empty credential", async () => {
    const { createQuery, state } = fakeQuery({ account: undefined })
    const exit = await run(createQuery)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.closed).toBe(1)
  })

  it("closes the process when the CLI fails to answer", async () => {
    const { createQuery, state } = fakeQuery({ fail: true })
    const exit = await run(createQuery)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.closed).toBe(1)
  })
})

describe("ClaudeCodeAuth.oauth", () => {
  it("offers one subscription method that verifies rather than signs in", async () => {
    const { createQuery } = fakeQuery({ account })
    const method = ClaudeCodeAuth.oauth({ createQuery, options: {} as Options })

    expect(method.integrationID).toBe(ClaudeCodeAuth.INTEGRATION_ID)
    expect(method.method).toEqual({
      id: ClaudeCodeAuth.METHOD_ID,
      type: "oauth",
      label: "Claude Code CLI (Pro/Max subscription)",
    })

    const authorization = await Effect.runPromise(method.authorize())
    expect(authorization.mode).toBe("auto")
    expect(authorization.instructions).toContain("already signed in")
  })

  it("labels the connection with the account, not a token", () => {
    const method = ClaudeCodeAuth.oauth({ createQuery: fakeQuery({}).createQuery, options: {} as Options })
    expect(
      method.label({
        type: "oauth",
        methodID: ClaudeCodeAuth.METHOD_ID,
        access: "claude-code-cli",
        refresh: "claude-code-cli",
        expires: 0,
        metadata: { email: "someone@example.com", subscriptionType: "max" },
      }),
    ).toBe("someone@example.com (max)")
  })

  it("still labels a connection whose account details are thin", () => {
    const method = ClaudeCodeAuth.oauth({ createQuery: fakeQuery({}).createQuery, options: {} as Options })
    const base = {
      type: "oauth" as const,
      methodID: ClaudeCodeAuth.METHOD_ID,
      access: "claude-code-cli",
      refresh: "claude-code-cli",
      expires: 0,
    }
    expect(method.label({ ...base, metadata: { subscriptionType: "pro" } })).toBe("pro")
    expect(method.label(base)).toBe("Claude Code CLI")
  })
})
