import { describe, expect, it } from "bun:test"
import type { Form } from "@opencode-ai/core/form"
import { ClaudeCodePermissionBridge } from "@opencode-ai/core/plugin/redsun/claude-code/permission-bridge"
import { ClaudeCodePermissions } from "@opencode-ai/core/plugin/redsun/claude-code/permissions"

const harness = (input?: {
  readonly deny?: readonly string[]
  readonly agent?: string
  readonly form?: Form.TerminalState | undefined
  /** Feedback the refusal carries, i.e. a decline the user typed a steer into. */
  readonly feedback?: string
  /** Actions whose assert never settles, standing in for an unanswered dialog. */
  readonly pending?: readonly string[]
  /** False when the user would rather keep planning. */
  readonly exitPlan?: boolean
}) => {
  const asked: { action: string; resource: string }[] = []
  const forms: Form.Field[][] = []
  let exitPlanCalls = 0
  const bridge = ClaudeCodePermissionBridge.make({
    worktree: "/repo",
    agent: () => input?.agent,
    assert: (action, resource) => {
      asked.push({ action, resource })
      if (input?.pending?.includes(action)) return new Promise<never>(() => {})
      if (!input?.deny?.includes(action)) return Promise.resolve({ ok: true as const })
      return Promise.resolve(
        input.feedback === undefined ? { ok: false as const } : { ok: false as const, feedback: input.feedback },
      )
    },
    form: async (fields) => {
      forms.push(fields)
      return input?.form
    },
    exitPlan: async () => {
      exitPlanCalls++
      return input?.exitPlan !== false
    },
  })
  return {
    bridge,
    asked,
    forms,
    actions: () => asked.map((entry) => entry.action),
    exitPlanCalls: () => exitPlanCalls,
  }
}

const live = { signal: new AbortController().signal }
const aborted = { signal: AbortSignal.abort() }

describe("ClaudeCodePermissionBridge", () => {
  it("allows read-only tools without asking anything", async () => {
    const h = harness({ deny: ["read", "claude_code"] })
    expect(await h.bridge("Grep", { pattern: "x" }, live)).toEqual({ behavior: "allow", updatedInput: { pattern: "x" } })
    expect(h.asked).toHaveLength(0)
  })

  it("refuses an aborted turn before asking the user anything", async () => {
    const h = harness()
    expect(await h.bridge("Bash", { command: "ls" }, aborted)).toEqual({ behavior: "deny", message: "Interrupted" })
    expect(h.asked).toHaveLength(0)
  })

  it("asks with the tool's mapped action and allows on approval", async () => {
    const h = harness()
    expect(await h.bridge("Bash", { command: "bun test" }, live)).toEqual({
      behavior: "allow",
      updatedInput: { command: "bun test" },
    })
    expect(h.asked).toEqual([{ action: "shell", resource: "bun test" }])
  })

  it("asks about an external directory before the tool's own permission", async () => {
    const h = harness()
    await h.bridge("Read", { file_path: "/elsewhere/secrets.txt" }, live)
    // Order matters: v2's own file tools gate the directory first, and a denied
    // directory must not be followed by a read prompt for the same path.
    expect(h.actions()).toEqual(["external_directory", "read"])
  })

  it("stops at a denied external directory", async () => {
    const h = harness({ deny: ["external_directory"] })
    expect(await h.bridge("Read", { file_path: "/elsewhere/secrets.txt" }, live)).toMatchObject({
      behavior: "deny",
      message: "Access to /elsewhere/* was denied",
    })
    expect(h.actions()).toEqual(["external_directory"])
  })

  it("does not ask about the worktree as an external directory", async () => {
    const h = harness()
    await h.bridge("Read", { file_path: "/repo/src/index.ts" }, live)
    expect(h.actions()).toEqual(["read"])
    expect(h.asked[0]?.resource).toBe("src/index.ts")
  })

  it("denies with the mapped action and resource", async () => {
    const h = harness({ deny: ["edit"] })
    expect(await h.bridge("Edit", { file_path: "/repo/src/index.ts" }, live)).toEqual({
      behavior: "deny",
      message: "Permission denied: edit src/index.ts",
    })
  })

  it("refuses compose's built-in subagent tool before asking anyone", async () => {
    // Compose allows `subagent/worker` and `subagent/explore`, so a native call
    // naming one of those would map onto an allow and run the subagent inside
    // Claude Code -- bypassing the worker-model routing compose exists for.
    // Policy, so it never reaches the rules.
    const h = harness({ agent: "compose" })
    for (const subagent_type of ["general", "worker", "explore"]) {
      expect(await h.bridge("Agent", { subagent_type }, live)).toEqual({
        behavior: "deny",
        message: ClaudeCodePermissions.COMPOSE_SUBAGENT_REDIRECT,
      })
      expect(await h.bridge("Task", { subagent_type }, live)).toMatchObject({ behavior: "deny" })
    }
    expect(h.asked).toHaveLength(0)
  })

  it("leaves a non-compose subagent deny as a plain refusal", async () => {
    // A worker's subagent deny is a genuine deny, not a routing mistake.
    const h = harness({ deny: ["subagent"], agent: "worker" })
    expect(await h.bridge("Agent", { subagent_type: "worker" }, live)).toEqual({
      behavior: "deny",
      message: "Permission denied: subagent worker",
    })
  })

  it("answers a granted question instead of allowing it unanswered", async () => {
    const h = harness({ form: { status: "answered", answer: { q0: "Postgres" } } as Form.TerminalState })
    const input = {
      questions: [{ question: "Which database?", header: "Database", multiSelect: false, options: [] }],
    }

    expect(await h.bridge("AskUserQuestion", input, live)).toEqual({
      behavior: "allow",
      // Keyed by the full question text, which is the SDK's contract.
      updatedInput: { ...input, answers: { "Which database?": "Postgres" } },
    })
    expect(h.actions()).toEqual(["question"])
    expect(h.forms[0]?.[0]).toMatchObject({ key: "q0", title: "Database", type: "string" })
  })

  it("denies a question the user dismissed", async () => {
    const h = harness({ form: { status: "cancelled" } as Form.TerminalState })
    expect(
      await h.bridge("AskUserQuestion", { questions: [{ question: "Which database?", options: [] }] }, live),
    ).toMatchObject({ behavior: "deny" })
  })

  it("denies a question whose form could not be created", async () => {
    const h = harness({ form: undefined })
    expect(
      await h.bridge("AskUserQuestion", { questions: [{ question: "Which database?", options: [] }] }, live),
    ).toMatchObject({ behavior: "deny" })
  })

  it("never opens a form for a denied question", async () => {
    const h = harness({ deny: ["question"] })
    expect(
      await h.bridge("AskUserQuestion", { questions: [{ question: "Which database?", options: [] }] }, live),
    ).toEqual({ behavior: "deny", message: "Permission denied: question" })
    expect(h.forms).toHaveLength(0)
  })

  it("falls back to the ordinary permission path for an unusable question input", async () => {
    const h = harness()
    await h.bridge("AskUserQuestion", { questions: [] }, live)
    expect(h.actions()).toEqual(["question"])
    expect(h.forms).toHaveLength(0)
  })

  it("gives an unknown tool its own action rather than widening a real one", async () => {
    const h = harness()
    await h.bridge("BashOutput", { id: "1" }, live)
    expect(h.asked).toEqual([{ action: "claude_code", resource: "BashOutput" }])
  })


  it("switches redsun out of plan mode when the plan is approved", async () => {
    // The CLI leaves its own plan mode on ExitPlanMode, but redsun would pin the
    // session back to `plan` -- and `modes.ts` would force plan permissions
    // again -- on the very next turn.
    const h = harness({ agent: "plan" })
    expect(await h.bridge("ExitPlanMode", { plan: "do the thing" }, live)).toEqual({
      behavior: "allow",
      updatedInput: { plan: "do the thing" },
    })
    expect(h.exitPlanCalls()).toBe(1)
  })

  it("stays in plan mode when the user is not done planning", async () => {
    const h = harness({ agent: "plan", exitPlan: false })
    expect(await h.bridge("ExitPlanMode", { plan: "draft" }, live)).toEqual({
      behavior: "deny",
      message: ClaudeCodePermissions.PLAN_KEEP_REFINING,
    })
  })

  it("refuses routed delegation while planning", async () => {
    // Plan mode makes the CLI's own session read-only, but a redsun subagent is
    // a different session with different rules -- delegating would write files
    // while redsun still shows plan.
    const h = harness({ agent: "plan" })
    expect(await h.bridge("mcp__redsun__subagent", { agent: "worker" }, live)).toEqual({
      behavior: "deny",
      message: ClaudeCodePermissions.PLAN_DELEGATION_REFUSED,
    })
    expect(h.asked).toHaveLength(0)
  })

  it("leaves routed delegation alone for every other agent", async () => {
    const h = harness({ agent: "compose" })
    expect(await h.bridge("mcp__redsun__subagent", { agent: "worker" }, live)).toMatchObject({ behavior: "allow" })
  })

  it("does not decide until the user has answered", async () => {
    // The regression this guards: `Permission.ask` returns `effect: "ask"` the
    // moment a request is registered, so a bridge built on it granted every
    // permission that should have prompted.
    const h = harness({ pending: ["shell"] })
    let settled = false
    void h.bridge("Bash", { command: "rm -rf /" }, live).then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    expect(h.actions()).toEqual(["shell"])
  })

  it("releases an unanswered request when the turn is interrupted", async () => {
    // Interrupting is exactly when a session is sitting on a dialog nobody
    // answered; without the race the CLI would stay blocked for good.
    const control = new AbortController()
    const h = harness({ pending: ["shell"] })
    const decision = h.bridge("Bash", { command: "sleep 100" }, { signal: control.signal })
    control.abort()
    expect(await decision).toEqual({ behavior: "deny", message: "Interrupted" })
  })

  it("hands a decline with feedback to the model instead of the refusal boilerplate", async () => {
    const h = harness({ deny: ["shell"], feedback: "use bun test, not npm" })
    expect(await h.bridge("Bash", { command: "npm test" }, live)).toEqual({
      behavior: "deny",
      message: "use bun test, not npm",
    })
  })

  it("leaves the built-in subagent tool alone for every other agent", async () => {
    // Build has no compose routing to bypass, so its native delegation is an
    // ordinary permission question.
    const h = harness({ agent: "build" })
    expect(await h.bridge("Agent", { subagent_type: "general" }, live)).toMatchObject({ behavior: "allow" })
    expect(h.asked).toEqual([{ action: "subagent", resource: "general" }])
  })
})
