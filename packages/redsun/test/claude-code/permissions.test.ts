import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Tool as AiTool } from "ai"
import { makeCanUseTool, type TurnContext } from "@/claude-code/permissions"
import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_claude_code_test")

const WORKTREE = process.platform === "win32" ? "C:\\repo" : "/repo"
const inside = (file: string) => path.join(WORKTREE, file)

function makeContext(input: {
  ask?: (askInput: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  questionAnswers?: string[][]
  questionRejects?: boolean
  agentName?: string
  ruleset?: PermissionV1.Ruleset
  taskTool?: AiTool
  planExitTool?: AiTool
}) {
  const asked: PermissionV1.AskInput[] = []
  const questions: unknown[] = []
  const ctx: TurnContext = {
    sessionID,
    agentName: input.agentName ?? "build",
    instance: { directory: WORKTREE, worktree: WORKTREE, project: {} as never },
    taskTool: input.taskTool,
    planExitTool: input.planExitTool,
    ruleset: input.ruleset ?? [],
    bridge: {
      promise: (effect) => Effect.runPromise(effect as Effect.Effect<never>),
      fork: () => {
        throw new Error("not used")
      },
      run: (effect) => effect as never,
      bind: (fn) => fn,
    },
    permission: {
      ask: (askInput) => {
        asked.push(askInput)
        return input.ask ? input.ask(askInput) : Effect.void
      },
      reply: () => Effect.void as never,
      list: () => Effect.succeed([]),
    },
    question: {
      ask: (questionInput) => {
        questions.push(questionInput)
        if (input.questionRejects) return Effect.fail({ _tag: "QuestionRejectedError" } as never)
        return Effect.succeed(input.questionAnswers ?? [])
      },
      reply: () => Effect.void as never,
      reject: () => Effect.void as never,
      list: () => Effect.succeed([]),
    },
  }
  return { ctx, asked, questions }
}

const signal = () => new AbortController().signal

describe("claude-code permission bridge", () => {
  test("read-only tools are allowed without asking", async () => {
    const { ctx, asked } = makeContext({})
    const canUseTool = makeCanUseTool(() => ctx)
    const result = await canUseTool("Glob", { pattern: "**" }, { signal: signal(), toolUseID: "t1" } as never)
    expect(result).toMatchObject({ behavior: "allow" })
    expect(asked).toHaveLength(0)
  })

  test("Bash maps onto the bash permission with the command as pattern", async () => {
    const { ctx, asked } = makeContext({})
    const canUseTool = makeCanUseTool(() => ctx)
    const result = await canUseTool("Bash", { command: "rm -rf build" }, { signal: signal(), toolUseID: "t2" } as never)
    expect(result).toMatchObject({ behavior: "allow", updatedInput: { command: "rm -rf build" } })
    expect(asked[0]).toMatchObject({ permission: "bash", patterns: ["rm -rf build"], sessionID })
  })

  test("Edit maps onto the edit permission with a worktree-relative pattern", async () => {
    const { ctx, asked } = makeContext({})
    const canUseTool = makeCanUseTool(() => ctx)
    await canUseTool("Write", { file_path: inside("src/a.ts") }, { signal: signal(), toolUseID: "t3" } as never)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ permission: "edit", patterns: [path.join("src", "a.ts")] })
  })

  test("plan rulesets deny ordinary edits but allow the plan file", async () => {
    const ruleset = Permission.fromConfig({
      edit: { "*": "deny", [path.join(".redsun", "plans", "*.md")]: "allow" },
    })
    const denied = makeContext({
      ruleset,
      ask: (askInput) =>
        Permission.evaluate(askInput.permission, askInput.patterns?.[0] ?? "*", askInput.ruleset ?? []).action === "deny"
          ? Effect.fail(new PermissionV1.DeniedError({ ruleset: askInput.ruleset ?? [] }))
          : (Effect.void as never),
    })
    const canUseTool = makeCanUseTool(() => denied.ctx)
    expect(
      await canUseTool("Write", { file_path: inside("src/a.ts") }, { signal: signal(), toolUseID: "p1" } as never),
    ).toMatchObject({ behavior: "deny" })
    expect(denied.asked[0]).toMatchObject({ patterns: [path.join("src", "a.ts")] })
    expect(
      await canUseTool(
        "Write",
        { file_path: inside(".redsun/plans/123-slug.md") },
        { signal: signal(), toolUseID: "p2" } as never,
      ),
    ).toMatchObject({ behavior: "allow" })
  })

  test("files outside the project ask for external_directory first", async () => {
    const { ctx, asked } = makeContext({})
    const canUseTool = makeCanUseTool(() => ctx)
    const outside = process.platform === "win32" ? "C:\\elsewhere\\notes.md" : "/elsewhere/notes.md"
    await canUseTool("Read", { file_path: outside }, { signal: signal(), toolUseID: "t3b" } as never)
    expect(asked).toHaveLength(2)
    expect(asked[0]).toMatchObject({ permission: "external_directory" })
    expect(asked[1]).toMatchObject({ permission: "read" })
  })

  test("rejection and correction map to deny with feedback", async () => {
    const rejected = makeContext({ ask: () => Effect.fail(new PermissionV1.RejectedError()) })
    const canUseToolRejected = makeCanUseTool(() => rejected.ctx)
    expect(
      await canUseToolRejected("Bash", { command: "ls" }, { signal: signal(), toolUseID: "t4" } as never),
    ).toMatchObject({ behavior: "deny", message: "The user rejected this tool call" })

    const corrected = makeContext({
      ask: () => Effect.fail(new PermissionV1.CorrectedError({ feedback: "use bun instead" })),
    })
    const canUseToolCorrected = makeCanUseTool(() => corrected.ctx)
    expect(
      await canUseToolCorrected("Bash", { command: "npm i" }, { signal: signal(), toolUseID: "t5" } as never),
    ).toMatchObject({ behavior: "deny", message: "use bun instead" })
  })

  test("unknown foreign tools map onto the claude_code permission", async () => {
    const { ctx, asked } = makeContext({})
    const canUseTool = makeCanUseTool(() => ctx)
    await canUseTool("SomeNewTool", { anything: 1 }, { signal: signal(), toolUseID: "t6" } as never)
    expect(asked[0]).toMatchObject({ permission: "claude_code", patterns: ["SomeNewTool"] })
  })

  test("AskUserQuestion routes to the question dialog and keys answers by question text", async () => {
    const { ctx } = makeContext({ questionAnswers: [["Option A"], ["X", "Y"]] })
    const canUseTool = makeCanUseTool(() => ctx)
    const input = {
      questions: [
        { question: "Which approach?", header: "Approach", options: [{ label: "Option A", description: "a" }] },
        {
          question: "Which features?",
          header: "Features",
          multiSelect: true,
          options: [
            { label: "X", description: "x" },
            { label: "Y", description: "y" },
          ],
        },
      ],
    }
    const result = await canUseTool("AskUserQuestion", input, { signal: signal(), toolUseID: "t7" } as never)
    expect(result).toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: { "Which approach?": "Option A", "Which features?": "X, Y" },
      },
    })
  })

  test("dismissed question dialogs deny", async () => {
    const { ctx } = makeContext({ questionRejects: true })
    const canUseTool = makeCanUseTool(() => ctx)
    const result = await canUseTool(
      "AskUserQuestion",
      { questions: [{ question: "Q?", header: "H", options: [{ label: "A", description: "" }] }] },
      { signal: signal(), toolUseID: "t8" } as never,
    )
    expect(result).toMatchObject({ behavior: "deny" })
  })

  test("a session that cannot ask questions denies AskUserQuestion", async () => {
    const { ctx, questions } = makeContext({ ruleset: Permission.fromConfig({ question: "deny" }) })
    const canUseTool = makeCanUseTool(() => ctx)
    const result = await canUseTool(
      "AskUserQuestion",
      { questions: [{ question: "Q?", header: "H", options: [{ label: "A", description: "" }] }] },
      { signal: signal(), toolUseID: "q1" } as never,
    )
    expect(result).toMatchObject({ behavior: "deny" })
    expect(questions).toHaveLength(0)
  })

  test("compose sends the built-in Task tool to redsun's routed task tool", async () => {
    const { ctx, asked } = makeContext({ agentName: "compose", taskTool: {} as AiTool })
    const canUseTool = makeCanUseTool(() => ctx)
    const result = await canUseTool(
      "Task",
      { subagent_type: "general-purpose", prompt: "do it" },
      { signal: signal(), toolUseID: "k1" } as never,
    )
    expect(result).toMatchObject({ behavior: "deny", message: expect.stringContaining("mcp__redsun__task") })
    expect(asked).toHaveLength(0)
  })

  test("plan mode refuses the routed task tool so read-only cannot be delegated around", async () => {
    const { ctx, asked } = makeContext({ agentName: "plan", taskTool: {} as AiTool })
    const canUseTool = makeCanUseTool(() => ctx)
    const result = await canUseTool(
      "mcp__redsun__task",
      { subagent_type: "worker", prompt: "edit files" },
      { signal: signal(), toolUseID: "k3" } as never,
    )
    expect(result).toMatchObject({ behavior: "deny", message: expect.stringContaining("read-only") })
    expect(asked).toHaveLength(0)
  })

  test("the built-in Task tool maps onto the task permission elsewhere", async () => {
    const { ctx, asked } = makeContext({ agentName: "build" })
    const canUseTool = makeCanUseTool(() => ctx)
    await canUseTool("Task", { subagent_type: "Explore" }, { signal: signal(), toolUseID: "k2" } as never)
    expect(asked[0]).toMatchObject({ permission: "task", patterns: ["Explore"] })
  })

  test("ExitPlanMode runs redsun's plan_exit tool and allows on approval", async () => {
    const calls: unknown[] = []
    const { ctx } = makeContext({
      agentName: "plan",
      planExitTool: { execute: async (args: unknown) => calls.push(args) } as unknown as AiTool,
    })
    const canUseTool = makeCanUseTool(() => ctx)
    expect(await canUseTool("ExitPlanMode", {}, { signal: signal(), toolUseID: "e1" } as never)).toMatchObject({
      behavior: "allow",
    })
    expect(calls).toHaveLength(1)
  })

  test("ExitPlanMode denies when the user keeps refining, and allows when plan_exit is unavailable", async () => {
    const rejecting = makeContext({
      agentName: "plan",
      planExitTool: {
        execute: async () => {
          throw new Error("rejected")
        },
      } as unknown as AiTool,
    })
    expect(
      await makeCanUseTool(() => rejecting.ctx)("ExitPlanMode", {}, { signal: signal(), toolUseID: "e2" } as never),
    ).toMatchObject({ behavior: "deny" })

    const missing = makeContext({ agentName: "plan" })
    expect(
      await makeCanUseTool(() => missing.ctx)("ExitPlanMode", {}, { signal: signal(), toolUseID: "e3" } as never),
    ).toMatchObject({ behavior: "allow" })
  })

  test("missing turn context denies", async () => {
    const canUseTool = makeCanUseTool(() => undefined)
    const result = await canUseTool("Bash", { command: "ls" }, { signal: signal(), toolUseID: "t9" } as never)
    expect(result).toMatchObject({ behavior: "deny" })
  })
})
