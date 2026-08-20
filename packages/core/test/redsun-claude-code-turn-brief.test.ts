import { describe, expect, it } from "bun:test"
import { ClaudeCodePermissions } from "@opencode-ai/core/plugin/redsun/claude-code/permissions"
import { ClaudeCodeTurnBrief } from "@opencode-ai/core/plugin/redsun/claude-code/turn-brief"

const brief = (input: Partial<ClaudeCodeTurnBrief.Input> = {}) =>
  ClaudeCodeTurnBrief.make({
    agent: { id: "build" },
    isWorker: false,
    agentChanged: true,
    ...input,
  })

describe("ClaudeCodeTurnBrief", () => {
  it("names the routed tool for compose", () => {
    // Without this, a compose session on Claude Code is never told how to
    // delegate: the agent's `system` is dropped because a delegated turn sends
    // no system prompt at all.
    const text = brief({ agent: { id: "compose" } })
    expect(text).toContain(ClaudeCodePermissions.ROUTED_SUBAGENT_TOOL)
    expect(text).toContain("worker")
    expect(text).toContain("explore")
    // The reason the built-in tool is refused, so the refusal is not a surprise.
    expect(text).toContain("built-in subagent tool is blocked")
  })

  it("tells a worker not to delegate further", () => {
    expect(brief({ isWorker: true })).toContain("Do not delegate further")
    // A subagent-mode agent counts even when the parent link is not known yet.
    expect(brief({ agent: { id: "worker", mode: "subagent" } })).toContain("Do not delegate further")
  })

  it("says nothing for build and plan", () => {
    // Plan mode is covered end to end by the CLI's own reminder plus
    // planModeInstructions; build needs no guidance.
    expect(brief()).toBeUndefined()
    expect(brief({ agent: { id: "plan" } })).toBeUndefined()
  })

  it("sends briefs once per agent switch, never per turn", () => {
    // The CLI keeps everything in conversation history: re-sending a standing
    // brief on every turn would break the cached prefix and add nothing.
    expect(brief({ agent: { id: "compose" }, agentChanged: false })).toBeUndefined()
    expect(brief({ isWorker: true, agentChanged: false })).toBeUndefined()
    expect(brief({ agent: { id: "reviewer", system: "You review diffs." }, agentChanged: false })).toBeUndefined()
  })

  it("sends a custom agent's prompt once per switch", () => {
    const agent = { id: "reviewer", system: "You review diffs." }
    expect(brief({ agent })).toBe("You review diffs.")
    expect(brief({ agent, agentChanged: false })).toBeUndefined()
  })

  it("carries both the mode brief and the agent prompt on a switch", () => {
    const text = brief({ agent: { id: "compose", system: "Prefer small diffs." } })
    expect(text).toContain(ClaudeCodePermissions.ROUTED_SUBAGENT_TOOL)
    expect(text?.endsWith("Prefer small diffs.")).toBe(true)
  })

  it("prefers compose's brief over the worker one", () => {
    // A compose session can itself be a child session; coordinating is still
    // what it is doing.
    expect(brief({ agent: { id: "compose" }, isWorker: true })).toContain("compose mode")
  })

  it("prepends without inventing a blank line", () => {
    expect(ClaudeCodeTurnBrief.prepend(undefined, "hello")).toBe("hello")
    expect(ClaudeCodeTurnBrief.prepend("note", "hello")).toBe("note\n\nhello")
    // An empty delta happens on a resumed turn; the brief still has to go.
    expect(ClaudeCodeTurnBrief.prepend("note", "")).toBe("note")
  })
})
