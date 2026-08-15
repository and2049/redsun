import { describe, expect, test } from "bun:test"
import { ClaudeCodeModes } from "@/claude-code/modes"

const base = { isWorker: false, hasRedsunTask: true, agentChanged: true }
const agent = (name: string, extra: { mode?: string; prompt?: string } = {}) => ({
  name,
  mode: extra.mode ?? "primary",
  ...(extra.prompt ? { prompt: extra.prompt } : {}),
})

describe("claude-code mode brief", () => {
  test("build and plan need no brief", () => {
    expect(ClaudeCodeModes.brief({ ...base, agent: agent("build") })).toBeUndefined()
    expect(ClaudeCodeModes.brief({ ...base, agent: agent("plan") })).toBeUndefined()
  })

  test("compose names the routed task tool and blocks the built-in one", () => {
    const brief = ClaudeCodeModes.brief({ ...base, agent: agent("compose") })
    expect(brief).toContain(ClaudeCodeModes.TASK_TOOL)
    expect(brief).toContain("worker")
    expect(brief).toContain("explore")
    expect(brief).toContain("worker routing")
    expect(brief).toContain("built-in Task tool is blocked")
  })

  test("compose without a routed task tool gets no delegation brief", () => {
    expect(ClaudeCodeModes.brief({ ...base, agent: agent("compose"), hasRedsunTask: false })).toBeUndefined()
  })

  test("subagent sessions are told not to delegate further", () => {
    expect(ClaudeCodeModes.brief({ ...base, agent: agent("worker", { mode: "subagent" }), isWorker: true })).toContain(
      "Do not delegate further",
    )
  })

  test("a custom agent's prompt is sent on the turn it becomes active, then not again", () => {
    const custom = agent("reviewer", { prompt: "You are a strict reviewer." })
    expect(ClaudeCodeModes.brief({ ...base, agent: custom })).toBe("You are a strict reviewer.")
    expect(ClaudeCodeModes.brief({ ...base, agent: custom, agentChanged: false })).toBeUndefined()
  })

  test("compose keeps its brief every turn while the agent prompt is sent once", () => {
    const custom = agent("compose", { prompt: "Extra house rules." })
    const first = ClaudeCodeModes.brief({ ...base, agent: custom })!
    const later = ClaudeCodeModes.brief({ ...base, agent: custom, agentChanged: false })!
    expect(first).toContain("Extra house rules.")
    expect(later).toContain(ClaudeCodeModes.TASK_TOOL)
    expect(later).not.toContain("Extra house rules.")
  })
})
