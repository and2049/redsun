import { describe, expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeProbe } from "@/claude-code/probe"
import type { CreateQuery, QueryLike } from "@/claude-code/sessions"

function fakeQuery(input: {
  init?: () => Promise<unknown>
  onClose?: () => void
}): CreateQuery {
  return () => {
    const query: QueryLike = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<SDKMessage>>(() => {}),
      }),
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      close: () => input.onClose?.(),
      ...(input.init ? { initializationResult: input.init } : {}),
    }
    return query
  }
}

describe("claude-code auth probe", () => {
  test("signed-in CLI reports account details and closes the probe process", async () => {
    let closed = 0
    const result = await ClaudeCodeProbe.probe({
      executablePath: "/bin/claude",
      createQuery: fakeQuery({
        init: async () => ({
          account: { email: "dev@example.com", subscriptionType: "max", apiProvider: "firstParty" },
        }),
        onClose: () => closed++,
      }),
    })
    expect(result).toEqual({
      ok: true,
      account: { email: "dev@example.com", subscription: "max", apiProvider: "firstParty" },
    })
    expect(closed).toBe(1)
  })

  test("empty account means not signed in", async () => {
    const result = await ClaudeCodeProbe.probe({
      executablePath: "/bin/claude",
      createQuery: fakeQuery({ init: async () => ({ account: {} }) }),
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain("not signed in")
  })

  test("init handshake failure surfaces the error", async () => {
    const result = await ClaudeCodeProbe.probe({
      executablePath: "/bin/claude",
      createQuery: fakeQuery({
        init: async () => {
          throw new Error("process exited with code 1")
        },
      }),
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain("process exited")
  })

  test("hung initialization times out", async () => {
    const result = await ClaudeCodeProbe.probe({
      executablePath: "/bin/claude",
      timeoutMs: 20,
      createQuery: fakeQuery({ init: () => new Promise(() => {}) }),
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain("Timed out")
  })
})
