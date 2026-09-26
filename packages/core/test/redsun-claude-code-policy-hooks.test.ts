import { describe, expect, it } from "bun:test"
import { ClaudeCodePolicyHooks } from "@redsun/runtime-claude-code/policy-hooks"
import { ClaudeCodePermissions } from "@redsun/runtime-claude-code/permissions"
import type { Form } from "@opencode/core/form"

const event = (tool_name: string, tool_input: unknown, tool_use_id = "call-1") =>
  ({
    hook_event_name: "PreToolUse",
    session_id: "native-1",
    cwd: "/repo",
    transcript_path: "",
    tool_name,
    tool_input,
    tool_use_id,
  }) as const

const setup = (options?: {
  agent?: string
  denied?: string[]
  pending?: boolean
  exit?: boolean
  exitFeedback?: string
  form?: Form.TerminalState
  served?: ReadonlySet<string>
}) => {
  const checked: string[] = []
  const prompted: string[] = []
  const planExits: [string, { approved: boolean; feedback?: string }][] = []
  let exits = 0
  let committed = 0
  let forms = 0
  const hooks = ClaudeCodePolicyHooks.make({
    worktree: "/repo",
    agent: () => options?.agent,
    isDirectHostTool: (name) => options?.served?.has(name) === true,
    onPlanExit: (id, outcome) => planExits.push([id, outcome]),
    policy: async (action, resource) => {
      checked.push(`${action}:${resource}`)
      return { effect: options?.denied?.includes(action) ? "deny" : "ask" }
    },
    assert: async (action) => {
      prompted.push(action)
      if (options?.pending) return new Promise<never>(() => {})
      return { ok: true }
    },
    form: async () => {
      forms++
      return options?.form
    },
    exitPlan: async () => {
      exits++
      if (options?.exit !== false) return { ok: true as const }
      return options.exitFeedback === undefined
        ? { ok: false as const }
        : { ok: false as const, feedback: options.exitFeedback }
    },
    commitPlanExit: async () => {
      committed++
    },
  })
  const pre = (tool: string, input: unknown, id?: string, signal = new AbortController().signal) =>
    hooks.preToolUse(event(tool, input, id), id, { signal })
  const callback = (
    tool: string,
    input: Record<string, unknown>,
    id = "call-1",
    signal = new AbortController().signal,
  ) => hooks.canUseTool(tool, input, { toolUseID: id, requestId: "request-1", signal })
  return {
    ...hooks,
    pre,
    callback,
    checked,
    prompted,
    planExits,
    exits: () => exits,
    committed: () => committed,
    forms: () => forms,
  }
}

describe("Claude Code mandatory PreToolUse policy", () => {
  it("blocks configured denials under native auto-approval, including reads and external directories", async () => {
    const h = setup({ denied: ["read", "external_directory"] })
    expect(await h.pre("Read", { file_path: "/repo/secret" })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "Permission denied: read secret" },
    })
    expect(await h.pre("Read", { file_path: "/other/secret" })).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "Permission denied: external_directory /other/*",
      },
    })
    expect(h.prompted).toEqual([])
  })

  it("checks external search paths before glob and grep patterns", async () => {
    const h = setup({ denied: ["external_directory"] })
    expect(await h.pre("Glob", { path: "/etc", pattern: "*.conf" })).toMatchObject({
      hookSpecificOutput: { permissionDecisionReason: "Permission denied: external_directory /etc/*" },
    })
    expect(await h.pre("Grep", { path: "/etc/passwd", pattern: "root" })).toMatchObject({
      hookSpecificOutput: { permissionDecisionReason: "Permission denied: external_directory /etc/*" },
    })
    expect(h.checked).toEqual(["external_directory:/etc/*", "external_directory:/etc/*"])
  })

  it("redirects compose native delegation but leaves build delegation subject to host policy", async () => {
    const compose = setup({ agent: "compose" })
    expect(await compose.pre("Agent", { subagent_type: "worker" })).toMatchObject({
      hookSpecificOutput: { permissionDecisionReason: ClaudeCodePermissions.COMPOSE_SUBAGENT_REDIRECT },
    })
    expect(compose.checked).toEqual([])
    const build = setup({ agent: "build", denied: ["subagent"] })
    expect(await build.pre("Task", { subagent_type: "worker" })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    })
    expect(build.checked).toEqual(["subagent:worker"])
    const allowed = setup({ agent: "build" })
    expect(await allowed.pre("Agent", { subagent_type: "general" })).toEqual({})
    expect(await allowed.callback("Agent", { subagent_type: "general" })).toMatchObject({ behavior: "allow" })
    expect(allowed.prompted).toEqual(["subagent"])
  })

  it("keeps plan-file edits, blocks source edits and routed delegation, and transitions only once", async () => {
    const plan = setup({ agent: "plan", denied: ["edit"] })
    expect(await plan.pre("mcp__redsun__subagent", { agent: "worker" })).toMatchObject({
      hookSpecificOutput: { permissionDecisionReason: ClaudeCodePermissions.PLAN_DELEGATION_REFUSED },
    })
    expect(await plan.pre("Write", { file_path: "/repo/src/app.ts" })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    })
    // A real policy evaluator has a path-specific allow after the general edit deny.
    const allowed = setup({ agent: "plan" })
    expect(await allowed.pre("Write", { file_path: "/home/user/.redsun/plan/draft.md" })).toEqual({})
    const input = { plan: "draft" }
    expect(await allowed.pre("ExitPlanMode", input)).toEqual({})
    expect(await allowed.callback("ExitPlanMode", input)).toMatchObject({ behavior: "allow" })
    expect(allowed.exits()).toBe(1)
    allowed.clear()
    const refining = setup({ agent: "plan", exit: false })
    expect(await refining.pre("ExitPlanMode", input)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: ClaudeCodePermissions.PLAN_KEEP_REFINING,
      },
    })
  })

  it("commits plan exit only after successful native execution, once and in the same session", async () => {
    const h = setup({ agent: "plan" })
    const input = { plan: "draft" }
    await h.pre("ExitPlanMode", input)
    await h.callback("ExitPlanMode", input)
    expect(h.committed()).toBe(0) // Native/managed denial after approval must leave the host in plan.
    const completed = { ...event("ExitPlanMode", input), hook_event_name: "PostToolUse" as const, tool_response: {} }
    const options = { signal: new AbortController().signal }
    await h.postToolUse({ ...completed, session_id: "another-session" }, "call-1", options)
    expect(h.committed()).toBe(0)
    await h.postToolUse(completed, "call-1", options)
    await h.postToolUse(completed, "call-1", options)
    expect(h.committed()).toBe(1)
    await h.pre("ExitPlanMode", input, "cancelled")
    h.clear()
    await h.postToolUse({ ...completed, tool_use_id: "cancelled" }, "cancelled", options)
    expect(h.committed()).toBe(1)
    await h.pre("ExitPlanMode", input, "completed-before-abort")
    const controller = new AbortController()
    controller.abort()
    await h.postToolUse({ ...completed, tool_use_id: "completed-before-abort" }, "completed-before-abort", {
      signal: controller.signal,
    })
    expect(h.committed()).toBe(2)
  })

  it("does not override native deny on allowed calls or open dialogs in the policy hook", async () => {
    const h = setup()
    expect(await h.pre("Bash", { command: "echo ok" })).toEqual({})
    expect(h.prompted).toEqual([])
    expect(await h.callback("Bash", { command: "echo ok" })).toMatchObject({ behavior: "allow" })
    expect(h.prompted).toEqual(["shell"])
  })

  it("serves questions under native approval and does not repeat the form in canUseTool", async () => {
    const h = setup({ form: { status: "answered", answer: { q0: "Yes" } } as Form.TerminalState })
    const input = { questions: [{ question: "Proceed?", options: [] }] }
    expect(await h.pre("AskUserQuestion", input)).toMatchObject({
      hookSpecificOutput: { updatedInput: { answers: { "Proceed?": "Yes" } } },
    })
    expect(h.forms()).toBe(1)
    expect(await h.callback("AskUserQuestion", input)).toMatchObject({ behavior: "allow" })
    expect(h.forms()).toBe(1)
    expect(h.prompted).toEqual(["question"])
    const denied = setup({ denied: ["question"] })
    expect(await denied.pre("AskUserQuestion", input)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    })
    expect(denied.forms()).toBe(0)
    h.clear()
  })

  it("cancels pending callback approval and denies an aborted hook", async () => {
    const h = setup({ pending: true })
    const controller = new AbortController()
    const result = h.callback("Bash", { command: "sleep 1" }, "call-2", controller.signal)
    controller.abort()
    expect(await result).toMatchObject({ behavior: "deny", message: "Interrupted" })
    expect(await h.pre("Bash", { command: "echo no" }, "call-3", controller.signal)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "Interrupted" },
    })
  })

  it("settles a hook if policy evaluation stalls and the turn is interrupted", async () => {
    const h = ClaudeCodePolicyHooks.make({
      worktree: "/repo",
      agent: () => "build",
      policy: () => new Promise<never>(() => {}),
      assert: async () => ({ ok: true }),
      form: async () => undefined,
      exitPlan: async () => ({ ok: true }),
    })
    const controller = new AbortController()
    const result = h.preToolUse(event("Bash", { command: "ls" }), "call-1", { signal: controller.signal })
    controller.abort()
    expect(await result).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: "Interrupted" } })
    h.clear()
  })

  it("preserves a plugin policy denial message without opening approval", async () => {
    const h = ClaudeCodePolicyHooks.make({
      worktree: "/repo",
      agent: () => "build",
      policy: async () => ({ effect: "deny", message: "Blocked by host plugin" }),
      assert: async () => {
        throw new Error("must not prompt")
      },
      form: async () => undefined,
      exitPlan: async () => ({ ok: true }),
    })
    expect(
      await h.preToolUse(event("Bash", { command: "ls" }), "call-1", { signal: new AbortController().signal }),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "Blocked by host plugin" },
    })
    h.clear()
  })

  it("leaves served host tools to their leaf without inspecting or prompting", async () => {
    const served = new Set(["mcp__redsun__read", "mcp__redsun__shell"])
    const h = setup({ agent: "build", denied: ["read", "shell", "external_directory", "claude_code"], served })
    expect(await h.pre("mcp__redsun__read", { path: "/other/secret" })).toEqual({})
    expect(await h.pre("mcp__redsun__shell", { command: "rm -rf /" })).toEqual({})
    expect(h.checked).toEqual([])
    const sdk = { toolUseID: "call-9", requestId: "r", signal: new AbortController().signal }
    expect(
      await h.canUseTool("mcp__redsun__read", { path: "x" }, { ...sdk, mcpServer: { name: "redsun", source: "sdk" } }),
    ).toMatchObject({ behavior: "allow" })
    expect(h.prompted).toEqual([])
    // Not served this turn: an unknown tool subject to host policy.
    expect(await h.pre("mcp__redsun__write", { path: "x" })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    })
    expect(h.checked).toEqual(["claude_code:mcp__redsun__write"])
    // The compose guard on native delegation stays for the profiles that have it.
    const compose = setup({ agent: "compose", served })
    expect(await compose.pre("Agent", { subagent_type: "worker" })).toMatchObject({
      hookSpecificOutput: { permissionDecisionReason: ClaudeCodePermissions.COMPOSE_SUBAGENT_REDIRECT },
    })
  })

  it("records approved and declined plan exits for the plan_exit row, feedback included", async () => {
    const approved = setup({ agent: "plan" })
    await approved.pre("ExitPlanMode", {}, "toolu_exit_ok")
    expect(approved.planExits).toEqual([["toolu_exit_ok", { approved: true }]])
    // canUseTool reuses the PreToolUse decision: one prompt, one record.
    expect(await approved.callback("ExitPlanMode", {}, "toolu_exit_ok")).toMatchObject({ behavior: "allow" })
    expect(approved.exits()).toBe(1)
    expect(approved.planExits).toHaveLength(1)

    const declined = setup({ agent: "plan", exit: false, exitFeedback: "cover the rollback" })
    expect(await declined.pre("ExitPlanMode", {}, "toolu_exit_no")).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: `${ClaudeCodePermissions.PLAN_KEEP_REFINING} The user said: cover the rollback`,
      },
    })
    expect(declined.planExits).toEqual([["toolu_exit_no", { approved: false, feedback: "cover the rollback" }]])
    // A decline never commits the transition.
    await declined.postToolUse(
      { ...event("ExitPlanMode", {}, "toolu_exit_no"), hook_event_name: "PostToolUse", tool_response: {} } as never,
      "toolu_exit_no",
      { signal: new AbortController().signal },
    )
    expect(declined.committed()).toBe(0)
  })

  it("isolates exit approvals by instance, ID and corrected input", async () => {
    const first = setup({ agent: "plan" })
    const second = setup({ agent: "plan" })
    await first.pre("ExitPlanMode", { plan: "a" }, "same")
    expect(await first.callback("ExitPlanMode", { plan: "a" }, "same")).toMatchObject({ behavior: "allow" })
    expect(first.exits()).toBe(1)
    await second.pre("ExitPlanMode", { plan: "a" }, "same")
    expect(await second.callback("ExitPlanMode", { plan: "b" }, "same")).toMatchObject({ behavior: "allow" })
    expect(second.exits()).toBe(2)
    first.clear()
    second.clear()
  })
})
