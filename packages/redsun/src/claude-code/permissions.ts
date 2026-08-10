import path from "path"
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Tool as AiTool } from "ai"
import type { EffectBridge } from "@/effect/bridge"
import { Permission } from "@/permission"
import { containsPath, type InstanceContext } from "@/project/instance-context"
import type { Question } from "@/question"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import { TASK_TOOL } from "./modes"

/**
 * Bridges the Agent SDK's `canUseTool` callback onto redsun's V1 permission
 * and question services, so Claude Code's tool approvals render in the
 * existing TUI dialogs. Foreign tool names map onto canonical redsun
 * permission ids so user rulesets (`permission.bash`, `permission.edit`, ...)
 * apply to delegated sessions unchanged.
 */

export interface TurnContext {
  readonly sessionID: SessionID
  /** Redsun agent driving this turn (`build`, `plan`, `compose`, ...). */
  readonly agentName: string
  readonly instance: InstanceContext
  readonly ruleset: PermissionV1.Ruleset
  readonly bridge: EffectBridge.Shape
  readonly permission: Permission.Interface
  readonly question: Question.Interface
  /** Present when redsun's routed `task` tool is available to this turn. */
  readonly taskTool?: AiTool
  /** Present only for the `plan` agent with experimental plan mode enabled. */
  readonly planExitTool?: AiTool
  readonly messages?: unknown[]
  readonly abort?: AbortSignal
}

const READONLY_TOOLS = new Set(["Glob", "Grep", "TodoWrite", "ListMcpResourcesTool"])
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const PATH_TOOLS = new Set([...EDIT_TOOLS, "Read"])

function targetPath(toolName: string, input: Record<string, unknown>): string | undefined {
  if (!PATH_TOOLS.has(toolName)) return undefined
  const value = input["file_path"] ?? input["notebook_path"]
  return typeof value === "string" && value.length ? value : undefined
}

/**
 * Redsun's own file tools ask with worktree-relative patterns
 * (`tool/write.ts`, `tool/read.ts`), and user rulesets are written to match
 * those. Claude Code reports absolute paths, so normalize before asking or no
 * `permission.edit` / `permission.read` glob would ever match.
 */
function mapPermission(
  toolName: string,
  input: Record<string, unknown>,
  ctx: TurnContext,
): { permission: string; pattern: string } {
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined)
  const file = targetPath(toolName, input)
  const relative = file ? path.relative(ctx.instance.worktree, file) : undefined
  if (toolName === "Bash") return { permission: "bash", pattern: text("command") ?? "*" }
  if (EDIT_TOOLS.has(toolName)) return { permission: "edit", pattern: relative || "*" }
  if (toolName === "Read") return { permission: "read", pattern: relative || "*" }
  if (toolName === "WebFetch") return { permission: "webfetch", pattern: text("url") ?? "*" }
  if (toolName === "WebSearch") return { permission: "webfetch", pattern: text("query") ?? "*" }
  if (toolName === "Task") return { permission: "task", pattern: text("subagent_type") ?? "*" }
  return { permission: "claude_code", pattern: toolName }
}

/** Mirrors `tool/external-directory.ts` for Claude-Code-executed file tools. */
function externalDirectory(toolName: string, input: Record<string, unknown>, ctx: TurnContext): string | undefined {
  const file = targetPath(toolName, input)
  if (!file) return undefined
  const full = process.platform === "win32" ? FSUtil.normalizePath(file) : file
  if (containsPath(full, ctx.instance)) return undefined
  const dir = path.dirname(full)
  return process.platform === "win32"
    ? FSUtil.normalizePathPattern(path.join(dir, "*"))
    : path.join(dir, "*").replaceAll("\\", "/")
}

type SdkQuestion = {
  question: string
  header: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

async function askUserQuestion(ctx: TurnContext, input: Record<string, unknown>): Promise<PermissionResult> {
  // Redsun gates its own `question` tool by stripping it from the tool list;
  // Claude Code's equivalent is always present, so apply the same rule here.
  if (Permission.disabled(["question"], ctx.ruleset).has("question"))
    return { behavior: "deny", message: "This session cannot ask the user questions" }
  const questions = Array.isArray(input.questions) ? (input.questions as SdkQuestion[]) : []
  if (!questions.length) return { behavior: "deny", message: "AskUserQuestion carried no questions" }
  try {
    const answers = await ctx.bridge.promise(
      ctx.question.ask({
        sessionID: ctx.sessionID,
        questions: questions.map((item) => ({
          question: item.question,
          header: item.header,
          multiple: item.multiSelect ?? false,
          options: (item.options ?? []).map((option) => ({
            label: option.label,
            description: option.description ?? "",
          })),
        })),
      }),
    )
    // SDK >= 2.1.121 looks answers up by full question text.
    const byQuestion: Record<string, string> = {}
    questions.forEach((item, index) => {
      const selected = answers[index] ?? []
      byQuestion[item.question] = selected.join(", ")
    })
    return { behavior: "allow", updatedInput: { questions: input.questions, answers: byQuestion } }
  } catch {
    return { behavior: "deny", message: "The user dismissed this question" }
  }
}

/**
 * Claude Code's own plan mode drives delegated plan sessions, so its native
 * `ExitPlanMode` stays the exit affordance — but redsun has to learn about the
 * approval or the session stays pinned to the `plan` agent. Running redsun's
 * already-resolved `plan_exit` tool reuses its approval question and its
 * switch to the build agent verbatim.
 */
async function exitPlanMode(ctx: TurnContext, input: Record<string, unknown>): Promise<PermissionResult> {
  const tool = ctx.planExitTool
  if (!tool?.execute) return { behavior: "allow", updatedInput: input }
  try {
    await tool.execute(
      {},
      {
        toolCallId: `claude-code-plan-exit-${PermissionV1.ID.ascending()}`,
        messages: (ctx.messages ?? []) as never,
        abortSignal: ctx.abort ?? new AbortController().signal,
      },
    )
    return { behavior: "allow", updatedInput: input }
  } catch {
    return { behavior: "deny", message: "The user wants to keep refining the plan. Stay in plan mode." }
  }
}

export function makeCanUseTool(getContext: () => TurnContext | undefined): CanUseTool {
  return async (toolName, input, options) => {
    const ctx = getContext()
    if (!ctx) return { behavior: "deny", message: "No active redsun turn for this Claude Code session" }
    if (toolName === "AskUserQuestion") return askUserQuestion(ctx, input)
    if (toolName === "ExitPlanMode") return exitPlanMode(ctx, input)
    if (READONLY_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input }
    // The routed task tool is attached to every session, and its subagents are
    // not bound by Claude Code's plan mode. Refuse it while planning so the
    // read-only guarantee cannot be delegated around.
    if (toolName === TASK_TOOL && ctx.agentName === "plan")
      return { behavior: "deny", message: "Plan mode is read-only. Delegate work after the plan is approved." }
    // Compose exists to route work onto whatever provider task_router assigns.
    // Claude Code's built-in Task would run subagents inside Claude Code and
    // silently bypass that, so send it to redsun's routed tool instead.
    if (toolName === "Task" && ctx.agentName === "compose" && ctx.taskTool)
      return {
        behavior: "deny",
        message: `Use the ${TASK_TOOL} tool (subagent_type: "worker" or "explore") in this session — the built-in Task tool bypasses redsun's task_router.`,
      }

    const mapped = mapPermission(toolName, input, ctx)
    const external = externalDirectory(toolName, input, ctx)
    const requests: { permission: string; pattern: string; metadata: Record<string, unknown> }[] = [
      ...(external
        ? [{ permission: "external_directory", pattern: external, metadata: { toolName, filepath: targetPath(toolName, input) } }]
        : []),
      {
        permission: mapped.permission,
        pattern: mapped.pattern,
        metadata: {
          toolName,
          input,
          ...(options.title ? { title: options.title } : {}),
          ...(options.description ? { description: options.description } : {}),
        },
      },
    ]

    for (const request of requests) {
      const id = PermissionV1.ID.ascending()
      const onAbort = () => {
        void ctx.bridge
          .promise(ctx.permission.reply({ requestID: id, reply: "reject" }).pipe(Effect.ignore))
          .catch(() => {})
      }
      options.signal.addEventListener("abort", onAbort, { once: true })
      try {
        await ctx.bridge.promise(
          ctx.permission.ask({
            id,
            sessionID: ctx.sessionID,
            permission: request.permission,
            patterns: [request.pattern],
            metadata: { ...request.metadata, claudeCode: true },
            always: [request.pattern],
            ruleset: ctx.ruleset,
          }),
        )
      } catch (error) {
        if (error instanceof PermissionV1.CorrectedError) return { behavior: "deny", message: error.feedback }
        if (error instanceof PermissionV1.DeniedError)
          return { behavior: "deny", message: "This tool is denied by the session's permission rules" }
        return { behavior: "deny", message: "The user rejected this tool call" }
      } finally {
        options.signal.removeEventListener("abort", onAbort)
      }
    }
    return { behavior: "allow", updatedInput: input }
  }
}

export * as ClaudeCodePermissions from "./permissions"
