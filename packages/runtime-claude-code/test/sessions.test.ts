import { describe, expect, it } from "bun:test"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeSessions } from "../src/sessions.js"

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

const startTurn = (manager: ClaudeCodeSessions.SessionManager, onExit?: () => void) =>
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
  it("signals when startup-only context must be re-established", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery)
    expect(manager.willStart("ses_1", "default")).toBe(true)
    const turn = await startTurn(manager)
    expect(manager.willStart("ses_1", "default")).toBe(false)
    expect(manager.willStart("ses_1", "bypassPermissions")).toBe(true)
    h.feed.push(result())
    for await (const _ of turn) void _
    manager.stop("ses_1")
    expect(manager.willStart("ses_1", "default")).toBe(true)
  })
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

describe("ClaudeCodeSessions.SessionManager held turns", () => {
  const frame = (type: string, extra: Record<string, unknown> = {}) =>
    ({ type, parent_tool_use_id: null, session_id: "claude_1", ...extra }) as unknown as SDKMessage

  const held = (manager: ClaudeCodeSessions.SessionManager, holdTurn: () => ClaudeCodeSessions.HoldReason) =>
    manager.turn("ses_1", prompt, { model: "sonnet", permissionMode: "default", holdTurn, options: {} } as never)

  const collect = (turn: AsyncIterable<SDKMessage>) => {
    const messages: SDKMessage[] = []
    let ended = false
    const done = (async () => {
      for await (const message of turn) messages.push(message)
      ended = true
    })()
    return { messages, ended: () => ended, done }
  }

  it("withholds the result while background agents run and ends on the continuation's result", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery)
    let reason: ClaudeCodeSessions.HoldReason = "active"
    const out = collect(await held(manager, () => reason))

    reason = "children"
    h.feed.push(result())
    await sleep(5)
    expect(out.ended()).toBe(false)
    expect(manager.busy("ses_1")).toBe(true)
    expect(out.messages).toHaveLength(0)

    // The agent reports, the CLI opens the continuation turn, it answers.
    reason = "active"
    h.feed.push(frame("assistant", { message: { content: [{ type: "text", text: "done" }] } }))
    await sleep(5)
    expect(out.messages.map((message) => message.type)).toEqual(["assistant"])
    reason = "none"
    const final = result()
    h.feed.push(final)
    await out.done
    expect(out.messages.map((message) => message.type)).toEqual(["assistant", "result"])
    expect(out.messages[1]).toBe(final)
    expect(manager.busy("ses_1")).toBe(false)
    manager.stopAll()
  })

  it("delivers the withheld result when nothing is pending any more", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery)
    let reason: ClaudeCodeSessions.HoldReason = "children"
    const out = collect(await held(manager, () => reason))
    const first = result()
    h.feed.push(first)
    await sleep(5)
    expect(out.ended()).toBe(false)

    // A stop notification settles the last agent without queueing a turn.
    reason = "none"
    h.feed.push(frame("system", { subtype: "task_notification", status: "stopped" }))
    await out.done
    expect(out.messages.map((message) => message.type)).toEqual(["system", "result"])
    expect(out.messages[1]).toBe(first)
    manager.stopAll()
  })

  it("bounds a wait for a queued continuation that never starts", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery, { continuationGraceMs: 20 })
    const out = collect(await held(manager, () => "queued"))
    const first = result()
    h.feed.push(first)
    await sleep(5)
    expect(out.ended()).toBe(false)
    await sleep(60)
    expect(out.ended()).toBe(true)
    expect(out.messages).toEqual([first])
    expect(manager.busy("ses_1")).toBe(false)
    expect(h.state.closed).toBe(0)
    manager.stopAll()
  })

  it("keeps waiting while the queued turn is announced within the grace", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery, { continuationGraceMs: 20 })
    let reason: ClaudeCodeSessions.HoldReason = "queued"
    const out = collect(await held(manager, () => reason))
    h.feed.push(result())
    await sleep(5)
    reason = "active"
    h.feed.push(frame("system", { subtype: "init" }))
    await sleep(60)
    expect(out.ended()).toBe(false)
    reason = "none"
    h.feed.push(result())
    await out.done
    expect(out.messages.map((message) => message.type)).toEqual(["system", "result"])
    manager.stopAll()
  })

  it("releases a held idle turn on interrupt without killing the process", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery, { interruptGraceMs: 20 })
    const out = collect(await held(manager, () => "children"))
    const first = result()
    h.feed.push(first)
    await sleep(5)

    await manager.interrupt("ses_1")
    await out.done
    expect(out.messages).toEqual([first])
    expect(h.state.interrupts).toBe(1)
    await sleep(40)
    expect(h.state.closed).toBe(0)
    expect(manager.busy("ses_1")).toBe(false)
    manager.stopAll()
  })

  it("never holds again once the turn was interrupted", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery, { interruptGraceMs: 5_000 })
    let reason: ClaudeCodeSessions.HoldReason = "active"
    const out = collect(await held(manager, () => reason))
    await manager.interrupt("ses_1")
    // The CLI kills the background agents; their entries have not settled yet.
    reason = "children"
    h.feed.push(result())
    await out.done
    expect(out.messages).toHaveLength(1)
    manager.stopAll()
  })

  it("never holds an unsuccessful result", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery)
    const out = collect(await held(manager, () => "children"))
    h.feed.push({ type: "result", subtype: "error_max_turns", session_id: "claude_1" } as unknown as SDKMessage)
    await out.done
    expect(out.messages).toHaveLength(1)
    manager.stopAll()
  })

  it("fails a held turn when the process dies", async () => {
    const h = harness()
    const manager = new ClaudeCodeSessions.SessionManager(h.createQuery)
    const out = collect(await held(manager, () => "children"))
    h.feed.push(result())
    await sleep(5)
    h.feed.end()
    await expect(out.done).rejects.toThrow("exited before the turn completed")
    expect(manager.busy("ses_1")).toBe(false)
  })
})
