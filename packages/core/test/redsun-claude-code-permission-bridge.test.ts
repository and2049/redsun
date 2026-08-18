import { describe, expect, it } from "bun:test"
import type { Form } from "@opencode-ai/core/form"
import { ClaudeCodePermissionBridge } from "@opencode-ai/core/plugin/redsun/claude-code/permission-bridge"
import { ClaudeCodePermissions } from "@opencode-ai/core/plugin/redsun/claude-code/permissions"

const harness = (input?: {
  readonly deny?: readonly string[]
  readonly agent?: string
  readonly form?: Form.TerminalState | undefined
}) => {
  const asked: { action: string; resource: string }[] = []
  const forms: Form.Field[][] = []
  const bridge = ClaudeCodePermissionBridge.make({
    worktree: "/repo",
    agent: () => input?.agent,
    ask: async (action, resource) => {
      asked.push({ action, resource })
      return { effect: input?.deny?.includes(action) ? "deny" : "allow" }
    },
    form: async (fields) => {
      forms.push(fields)
      return input?.form
    },
  })
  return { bridge, asked, forms, actions: () => asked.map((entry) => entry.action) }
}

const live = { signal: { aborted: false } as AbortSignal }
const aborted = { signal: { aborted: true } as AbortSignal }

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

  it("redirects a denied compose delegation to the routed tool", async () => {
    const h = harness({ deny: ["subagent"], agent: "compose" })
    expect(await h.bridge("Agent", { subagent_type: "general" }, live)).toEqual({
      behavior: "deny",
      message: ClaudeCodePermissions.COMPOSE_SUBAGENT_REDIRECT,
    })
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
})
