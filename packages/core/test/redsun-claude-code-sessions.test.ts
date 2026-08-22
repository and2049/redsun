import { describe, expect, it } from "bun:test"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeSessions } from "@opencode-ai/core/plugin/redsun/claude-code/sessions"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// A hand-driven CLI stand-in: the test decides when frames arrive and when the
// process dies, independent of the prompt queue.
class Feed implements AsyncIterable<SDKMessage> {
  private values: SDKMessage[] = []
  private waiters: ((result: IteratorResult<SDKMessage>) => void)[] = []
  private done = false

  push(value: SDKMessage) {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  end() {
    if (this.done) return
    this.done = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false })
        if (this.done) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

const result = () => ({ type: "result", subtype: "success", session_id: "claude_1" }) as unknown as SDKMessage

const harness = (input?: { interruptRejects?: boolean }) => {
  const feed = new Feed()
  const state = { closed: 0, interrupts: 0 }
  const createQuery: ClaudeCodeSessions.CreateQuery = () => ({
    [Symbol.asyncIterator]: () => feed[Symbol.asyncIterator](),
    interrupt: async () => {
      state.interrupts += 1
      if (input?.interruptRejects) throw new Error("interrupt failed")
    },
    setModel: async () => undefined,
    setPermissionMode: async () => undefined,
    close: () => {
      state.closed += 1
      feed.end()
    },
  })
  return { feed, state, createQuery }
}

const prompt: SDKUserMessage["message"]["content"] = [{ type: "text", text: "hi" }]

const startTurn = (
  manager: ClaudeCodeSessions.SessionManager,
  onExit?: () => void,
) =>
  manager.turn("ses_1", prompt, {
    model: "sonnet",
    permissionMode: "default",
    ...(onExit ? { onExit } : {}),
    options: {},
  } as never)

describe("ClaudeCodeSessions.SessionManager interrupt fallback", () => {
  it("kills the process when an interrupt is acknowledged but the turn never ends", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery, { interruptGraceMs: 20 })
    await startTurn(manager)
    expect(manager.busy("ses_1")).toBe(true)

    await manager.interrupt("ses_1")
    await sleep(60)

    expect(h.state.closed).toBe(1)
    expect(manager.busy("ses_1")).toBe(false)
    manager.stopAll()
  })

  it("stops immediately when the interrupt itself fails", async () => {
    const h = harness({ interruptRejects: true })
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery, { interruptGraceMs: 5_000 })
    await startTurn(manager)

    await manager.interrupt("ses_1")

    expect(h.state.closed).toBe(1)
    expect(manager.busy("ses_1")).toBe(false)
    manager.stopAll()
  })

  it("leaves a turn alone that ends within the grace period", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery, { interruptGraceMs: 40 })
    const turn = await startTurn(manager)

    await manager.interrupt("ses_1")
    h.feed.push(result())
    for await (const _ of turn) void _
    await sleep(80)

    expect(h.state.closed).toBe(0)
    expect(manager.busy("ses_1")).toBe(false)
    manager.stopAll()
  })
})

describe("ClaudeCodeSessions.SessionManager onExit", () => {
  it("fires once when the process dies, even if stop follows", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery)
    let exits = 0
    await startTurn(manager, () => {
      exits += 1
    })

    h.feed.end()
    await sleep(10)
    expect(exits).toBe(1)

    manager.stop("ses_1")
    await sleep(10)
    expect(exits).toBe(1)
  })

  it("fires on stop for a live process", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery)
    let exits = 0
    await startTurn(manager, () => {
      exits += 1
    })

    manager.stop("ses_1")
    await sleep(10)
    expect(exits).toBe(1)
  })
})
