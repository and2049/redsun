export * as ClaudeCodePermissionBridge from "./permission-bridge.js"

import type { Form } from "../../../form.js"
import { ClaudeCodePermissions } from "./permissions.js"
import { ClaudeCodeQuestions } from "./questions.js"

export type Decision =
  | { readonly behavior: "allow"; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message: string }

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly feedback?: string }

export interface Ports {
  readonly worktree: string
  readonly agent: () => string | undefined
  readonly assert: (action: string, resource: string, signal: AbortSignal) => Promise<Outcome>
  readonly form: (fields: Form.Field[], signal: AbortSignal) => Promise<Form.TerminalState | undefined>
  readonly exitPlan: (signal: AbortSignal) => Promise<boolean>
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
  async (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal
      mcpServer?: { name: string; source: string }
    },
  ): Promise<Decision> => {
    const allow = { behavior: "allow", updatedInput: input } as const
    if (options.signal.aborted) return { behavior: "deny", message: INTERRUPTED }

    const decide = async (action: string, resource: string): Promise<Outcome | "aborted"> => {
      const abort = aborted(options.signal)
      try {
        return await Promise.race([ports.assert(action, resource, options.signal), abort.promise])
      } finally {
        abort.detach()
      }
    }

    if (toolName === ClaudeCodePermissions.EXIT_PLAN_TOOL) {
      const exitAbort = aborted(options.signal)
      try {
        return (await Promise.race([ports.exitPlan(options.signal), exitAbort.promise])) === true
          ? allow
          : {
              behavior: "deny",
              message: options.signal.aborted ? INTERRUPTED : ClaudeCodePermissions.PLAN_KEEP_REFINING,
            }
      } finally {
        exitAbort.detach()
      }
    }

    const reason = ClaudeCodePermissions.policyReason(toolName, ports.agent())
    if (reason) return { behavior: "deny", message: reason }

    // The in-process host tool executes through Tool.Snapshot and its leaf owns
    // the interactive permission. Do not ask here and then ask again at the leaf.
    // Name alone is not proof: inherited/user MCP servers may spoof the prefix.
    if (
      ClaudeCodePermissions.isHostTool(toolName) &&
      options.mcpServer?.source === "sdk" &&
      options.mcpServer.name === "redsun"
    )
      return allow

    if (toolName === ClaudeCodeQuestions.TOOL_NAME) {
      const questions = ClaudeCodeQuestions.parse(input)
      if (questions) {
        const answer = await decide("question", "*")
        if (answer === "aborted") return { behavior: "deny", message: INTERRUPTED }
        if (!answer.ok) return { behavior: "deny", message: answer.feedback ?? "Permission denied: question" }
        const formAbort = aborted(options.signal)
        const state = await Promise.race([
          ports.form(ClaudeCodeQuestions.fields(questions), options.signal),
          formAbort.promise,
        ])
        formAbort.detach()
        if (!state || state === "aborted" || state.status === "cancelled" || options.signal.aborted)
          return { behavior: "deny", message: "The user dismissed this question." }
        return {
          behavior: "allow",
          updatedInput: { ...input, answers: ClaudeCodeQuestions.answers(questions, state.answer) },
        }
      }
    }

    const pathAbort = aborted(options.signal)
    const external = await Promise.race([
      ClaudeCodePermissions.externalDirectory({ toolName, input, worktree: ports.worktree }),
      pathAbort.promise,
    ])
    pathAbort.detach()
    if (external === "aborted") return { behavior: "deny", message: INTERRUPTED }
    if (external) {
      const outside = await decide("external_directory", external)
      if (outside === "aborted") return { behavior: "deny", message: INTERRUPTED }
      if (!outside.ok) return { behavior: "deny", message: outside.feedback ?? `Access to ${external} was denied` }
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
