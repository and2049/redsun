import { describe, expect, it } from "bun:test"
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeModes } from "@opencode-ai/core/plugin/redsun/claude-code/modes"
import { ClaudeCodeSessions } from "@opencode-ai/core/plugin/redsun/claude-code/sessions"

describe("ClaudeCodeModes.permissionMode", () => {
  it("forces plan mode for the plan agent", () => {
    expect(ClaudeCodeModes.permissionMode({ agentID: "plan" })).toBe("plan")
  })

  it("does not let config weaken plan mode", () => {
    // The whole point: a delegated session sends no system prompt, so config is
    // otherwise the only input and a global bypassPermissions would silently
    // turn the read-only agent into a writable one.
    expect(ClaudeCodeModes.permissionMode({ agentID: "plan", configured: "bypassPermissions" })).toBe("plan")
    expect(ClaudeCodeModes.permissionMode({ agentID: "plan", configured: "acceptEdits" })).toBe("plan")
  })

  it("applies worker_permission_mode to subagent-driven sessions", () => {
    expect(
      ClaudeCodeModes.permissionMode({
        agentID: "worker",
        agentMode: "subagent",
        configured: "acceptEdits",
        worker: "plan",
      }),
    ).toBe("plan")
  })

  it("defers to the primary mode when the worker mode inherits", () => {
    expect(
      ClaudeCodeModes.permissionMode({
        agentID: "worker",
        agentMode: "subagent",
        configured: "acceptEdits",
        worker: "inherit",
      }),
    ).toBe("acceptEdits")
  })

  it("leaves primary agents on the configured mode", () => {
    expect(
      ClaudeCodeModes.permissionMode({
        agentID: "build",
        agentMode: "primary",
        configured: "acceptEdits",
        worker: "plan",
      }),
    ).toBe("acceptEdits")
  })

  it("falls back to default for an absent or unknown mode", () => {
    expect(ClaudeCodeModes.permissionMode({})).toBe("default")
    expect(ClaudeCodeModes.permissionMode({ configured: "not-a-mode" })).toBe("default")
    expect(
      ClaudeCodeModes.permissionMode({ agentID: "worker", agentMode: "subagent", worker: "not-a-mode" }),
    ).toBe("default")
  })
})

const fakeQuery = (spawns: { options: Options }[]) => {
  const calls: { setPermissionMode: string[] } = { setPermissionMode: [] }
  const createQuery: ClaudeCodeSessions.CreateQuery = (input) => {
    spawns.push({ options: input.options })
    return {
      // Answer each prompt with a `result`, which is what closes the turn
      // window, and stay alive between turns like a real CLI process.
      [Symbol.asyncIterator]: async function* () {
        for await (const _ of input.prompt as AsyncIterable<SDKUserMessage>)
          yield { type: "result", subtype: "success", session_id: "claude_1" } as unknown as SDKMessage
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async (mode) => {
        calls.setPermissionMode.push(mode)
      },
      close: () => undefined,
    }
  }
  return { createQuery, calls }
}

const prompt: SDKUserMessage["message"]["content"] = [{ type: "text", text: "hi" }]

const runTurn = async (manager: ClaudeCodeSessions.SessionManager, permissionMode: string, resume?: string) => {
  const stream = await manager.turn("ses_1", prompt, {
    model: "sonnet",
    permissionMode,
    options: { ...(resume ? { resume } : {}) },
  } as never)
  // Draining to the `result` is what a real turn does, and it is what releases
  // the session for the next one.
  for await (const _ of stream) void _
}

describe("ClaudeCodeSessions.SessionManager permission modes", () => {
  it("switches an ordinary live process without respawning it", async () => {
    const spawns: { options: Options }[] = []
    const { createQuery, calls } = fakeQuery(spawns)
    const manager = new ClaudeCodeSessions.SessionManager(createQuery)

    await runTurn(manager, "default")
    await runTurn(manager, "plan")

    expect(spawns).toHaveLength(1)
    expect(calls.setPermissionMode).toEqual(["plan"])
    manager.stopAll()
  })

  it("respawns when raising a process into bypassPermissions", async () => {
    const spawns: { options: Options }[] = []
    const { createQuery } = fakeQuery(spawns)
    const manager = new ClaudeCodeSessions.SessionManager(createQuery)

    await runTurn(manager, "default")
    await runTurn(manager, "bypassPermissions", "claude_1")

    expect(spawns).toHaveLength(2)
    expect(spawns[1]?.options.allowDangerouslySkipPermissions).toBe(true)
    expect(spawns[1]?.options.resume).toBe("claude_1")
    manager.stopAll()
  })

  it("respawns when lowering a bypassing process into plan", async () => {
    const spawns: { options: Options }[] = []
    const { createQuery, calls } = fakeQuery(spawns)
    const manager = new ClaudeCodeSessions.SessionManager(createQuery)

    await runTurn(manager, "bypassPermissions")
    await runTurn(manager, "plan", "claude_1")

    // setPermissionMode alone would leave --dangerously-skip-permissions on the
    // process, so "plan" would be enforced in name only.
    expect(spawns).toHaveLength(2)
    expect(spawns[1]?.options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(spawns[1]?.options.resume).toBe("claude_1")
    expect(calls.setPermissionMode).toEqual([])
    manager.stopAll()
  })
})
