export * as ClaudeCodePermissionBridge from "./permission-bridge.js"

import type { Form } from "../../../form.js"
import { ClaudeCodeModes } from "./modes.js"
import { ClaudeCodePermissions } from "./permissions.js"
import { ClaudeCodeQuestions } from "./questions.js"

export type Decision =
  | { readonly behavior: "allow"; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message: string }

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly feedback?: string }

export interface Ports {
  readonly worktree: string
  readonly agent: () => string | undefined
  readonly assert: (action: string, resource: string) => Promise<Outcome>
  readonly form: (fields: Form.Field[]) => Promise<Form.TerminalState | undefined>
  readonly exitPlan: () => Promise<boolean>
}

const INTERRUPTED = "Interrupted"

const aborted = (signal: AbortSignal) => {
  let detach = () => {}
  const promise = new Promise<"aborted">((resolve) => {
    if (signal.aborted) return resolve("aborted")
    const onAbort = () => resolve("aborted")
    signal.addEventListener("abort", onAbort, { once: true })
    detach = () => signal.removeEventListener("abort", onAbort)
  })
  return { promise, detach }
}

export const make =
  (ports: Ports) =>
  async (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<Decision> => {
    const allow = { behavior: "allow", updatedInput: input } as const
    if (ClaudeCodePermissions.isReadOnly(toolName)) return allow
    if (options.signal.aborted) return { behavior: "deny", message: INTERRUPTED }

    const decide = async (action: string, resource: string): Promise<Outcome | "aborted"> => {
      const abort = aborted(options.signal)
      try {
        return await Promise.race([ports.assert(action, resource), abort.promise])
      } finally {
        abort.detach()
      }
    }

    if (toolName === ClaudeCodePermissions.EXIT_PLAN_TOOL)
      return (await ports.exitPlan())
        ? allow
        : { behavior: "deny", message: ClaudeCodePermissions.PLAN_KEEP_REFINING }

    if (toolName === ClaudeCodePermissions.ROUTED_SUBAGENT_TOOL && ports.agent() === ClaudeCodeModes.PLAN_AGENT)
      return { behavior: "deny", message: ClaudeCodePermissions.PLAN_DELEGATION_REFUSED }

    if (ClaudeCodePermissions.SUBAGENT_TOOLS.has(toolName) && ports.agent() === ClaudeCodePermissions.COMPOSE_AGENT)
      return { behavior: "deny", message: ClaudeCodePermissions.COMPOSE_SUBAGENT_REDIRECT }

    if (toolName === ClaudeCodeQuestions.TOOL_NAME) {
      const questions = ClaudeCodeQuestions.parse(input)
      if (questions) {
        const answer = await decide("question", "*")
        if (answer === "aborted") return { behavior: "deny", message: INTERRUPTED }
        if (!answer.ok)
          return { behavior: "deny", message: answer.feedback ?? "Permission denied: question" }
        const state = await ports.form(ClaudeCodeQuestions.fields(questions))
        if (!state || state.status === "cancelled" || options.signal.aborted)
          return { behavior: "deny", message: "The user dismissed this question." }
        return {
          behavior: "allow",
          updatedInput: { ...input, answers: ClaudeCodeQuestions.answers(questions, state.answer) },
        }
      }
    }

    const external = ClaudeCodePermissions.externalDirectory({ toolName, input, worktree: ports.worktree })
    if (external) {
      const outside = await decide("external_directory", external)
      if (outside === "aborted") return { behavior: "deny", message: INTERRUPTED }
      if (!outside.ok)
        return { behavior: "deny", message: outside.feedback ?? `Access to ${external} was denied` }
    }

    const mapped = ClaudeCodePermissions.mapPermission({ toolName, input, worktree: ports.worktree })
    const outcome = await decide(mapped.action, mapped.resource)
    if (outcome === "aborted") return { behavior: "deny", message: INTERRUPTED }
    if (!outcome.ok) {
      if (outcome.feedback) return { behavior: "deny", message: outcome.feedback }
      return { behavior: "deny", message: `Permission denied: ${mapped.action} ${mapped.resource}` }
    }
    return allow
  }
