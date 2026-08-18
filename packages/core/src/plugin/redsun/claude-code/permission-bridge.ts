// REDSUN: the SDK's `canUseTool` callback, expressed over injected ports.
//
// Claude Code executes its own tools, so its approvals arrive here rather than
// through v2's tool layer. Bridging them onto Permission.Service is what makes a
// user's existing rules apply to delegated sessions at all.
//
// The decision logic lives here, away from the plugin's service wiring, so the
// order it enforces is testable: read-only tools never ask, an aborted turn
// never asks, external directories are asked before the tool's own permission
// (mirroring v2's file tools), and a granted question is actually answered
// rather than merely allowed.
export * as ClaudeCodePermissionBridge from "./permission-bridge.js"

import type { Form } from "../../../form.js"
import { ClaudeCodePermissions } from "./permissions.js"
import { ClaudeCodeQuestions } from "./questions.js"

export type Decision =
  | { readonly behavior: "allow"; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message: string }

export interface Ports {
  /** The project worktree, for relative permission patterns. */
  readonly worktree: string
  /** The agent driving this session, when one has been recorded. */
  readonly agent: () => string | undefined
  /** Ask Permission.Service. Anything other than an allow denies. */
  readonly ask: (action: string, resource: string) => Promise<{ readonly effect: string }>
  /** Ask Form.Service. Undefined when the form could not be created. */
  readonly form: (fields: Form.Field[]) => Promise<Form.TerminalState | undefined>
}

export const make =
  (ports: Ports) =>
  async (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal }): Promise<Decision> => {
    const allow = { behavior: "allow", updatedInput: input } as const
    if (ClaudeCodePermissions.isReadOnly(toolName)) return allow
    if (options.signal.aborted) return { behavior: "deny", message: "Interrupted" }

    // A granted question still needs somewhere to be answered: Claude Code has
    // no terminal here, so an allow without answers stalls the turn.
    if (toolName === ClaudeCodeQuestions.TOOL_NAME) {
      const questions = ClaudeCodeQuestions.parse(input)
      if (questions) {
        if ((await ports.ask("question", "*")).effect === "deny")
          return { behavior: "deny", message: "Permission denied: question" }
        const state = await ports.form(ClaudeCodeQuestions.fields(questions))
        if (!state || state.status === "cancelled" || options.signal.aborted)
          return { behavior: "deny", message: "The user dismissed this question." }
        return {
          behavior: "allow",
          updatedInput: { ...input, answers: ClaudeCodeQuestions.answers(questions, state.answer) },
        }
      }
    }

    // External directories are asked first, mirroring v2's own file tools.
    const external = ClaudeCodePermissions.externalDirectory({ toolName, input, worktree: ports.worktree })
    if (external && (await ports.ask("external_directory", external)).effect === "deny")
      return { behavior: "deny", message: `Access to ${external} was denied` }

    const mapped = ClaudeCodePermissions.mapPermission({ toolName, input, worktree: ports.worktree })
    if ((await ports.ask(mapped.action, mapped.resource)).effect === "deny") {
      // Compose denies the native subagent tool by design, so point the model at
      // the routed one rather than leaving it at a dead end.
      if (mapped.action === "subagent" && ports.agent() === "compose")
        return { behavior: "deny", message: ClaudeCodePermissions.COMPOSE_SUBAGENT_REDIRECT }
      return { behavior: "deny", message: `Permission denied: ${mapped.action} ${mapped.resource}` }
    }
    return allow
  }
