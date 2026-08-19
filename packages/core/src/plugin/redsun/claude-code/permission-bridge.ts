// REDSUN: the SDK's `canUseTool` callback, expressed over injected ports.
//
// Claude Code executes its own tools, so its approvals arrive here rather than
// through v2's tool layer. Bridging them onto Permission.Service is what makes a
// user's existing rules apply to delegated sessions at all.
//
// The port is `assert`, not `ask`, and the difference is the whole point.
// `Permission.ask` registers a pending request and returns immediately with
// `effect: "ask"` -- it is the "evaluate and maybe create" API the HTTP layer
// uses. Only `assert` awaits the user's answer. Every other tool in v2 calls
// `assert`; when this bridge called `ask` and treated anything that was not
// "deny" as an allow, every permission that should have prompted was silently
// granted while a request nobody would answer piled up in the pending map.
//
// The decision logic lives here, away from the plugin's service wiring, so the
// order it enforces is testable: read-only tools never ask, an aborted turn
// never asks, external directories are asked before the tool's own permission
// (mirroring v2's file tools), and a granted question is actually answered
// rather than merely allowed.
export * as ClaudeCodePermissionBridge from "./permission-bridge.js"

import type { Form } from "../../../form.js"
import { ClaudeCodeModes } from "./modes.js"
import { ClaudeCodePermissions } from "./permissions.js"
import { ClaudeCodeQuestions } from "./questions.js"

export type Decision =
  | { readonly behavior: "allow"; readonly updatedInput: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message: string }

/**
 * The user's answer. `feedback` carries a decline that came with a steer, which
 * v2 models as `Permission.CorrectedError` and hands to the model as tool
 * output so it can adjust rather than stop.
 */
export type Outcome = { readonly ok: true } | { readonly ok: false; readonly feedback?: string }

export interface Ports {
  /** The project worktree, for relative permission patterns. */
  readonly worktree: string
  /** The agent driving this session, when one has been recorded. */
  readonly agent: () => string | undefined
  /**
   * Ask Permission.Service and **wait** for the answer. Resolves approved or
   * refused; it must not resolve while the request is still pending.
   */
  readonly assert: (action: string, resource: string) => Promise<Outcome>
  /** Ask Form.Service. Undefined when the form could not be created. */
  readonly form: (fields: Form.Field[]) => Promise<Form.TerminalState | undefined>
  /**
   * Leave plan mode on redsun's side: the CLI's own `ExitPlanMode` ends its
   * read-only mode inside the process, but redsun would stay pinned to the plan
   * agent and force `permissionMode: "plan"` again on the very next turn.
   * Resolves false when the user would rather keep planning.
   */
  readonly exitPlan: () => Promise<boolean>
}

const INTERRUPTED = "Interrupted"

/** Resolves once the signal aborts, and detaches its listener either way. */
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

    /**
     * Wait for the user, but never past the end of the turn. Interrupting is
     * exactly when a session is sitting on an unanswered dialog, and a promise
     * that only settles on a reply would leave the CLI blocked for good.
     */
    const decide = async (action: string, resource: string): Promise<Outcome | "aborted"> => {
      const abort = aborted(options.signal)
      try {
        return await Promise.race([ports.assert(action, resource), abort.promise])
      } finally {
        abort.detach()
      }
    }

    // Approving the plan has to reach redsun, or the session stays on the plan
    // agent and the next turn is read-only all over again.
    if (toolName === ClaudeCodePermissions.EXIT_PLAN_TOOL)
      return (await ports.exitPlan())
        ? allow
        : { behavior: "deny", message: ClaudeCodePermissions.PLAN_KEEP_REFINING }

    // The routed subagent tool is attached to every turn (mcp.ts), and its
    // children run in their own sessions -- outside the CLI's plan mode.
    if (toolName === ClaudeCodePermissions.ROUTED_SUBAGENT_TOOL && ports.agent() === ClaudeCodeModes.PLAN_AGENT)
      return { behavior: "deny", message: ClaudeCodePermissions.PLAN_DELEGATION_REFUSED }

    // Compose's built-in subagent tool is refused outright rather than through
    // the rules. Compose allows `subagent/worker` and `subagent/explore`, so a
    // native call naming one of those would map onto an allow and run the
    // subagent *inside* Claude Code -- bypassing worker-model routing, which is
    // the entire point of compose. This is policy, not something a rule tunes.
    if (ClaudeCodePermissions.SUBAGENT_TOOLS.has(toolName) && ports.agent() === ClaudeCodePermissions.COMPOSE_AGENT)
      return { behavior: "deny", message: ClaudeCodePermissions.COMPOSE_SUBAGENT_REDIRECT }

    // A granted question still needs somewhere to be answered: Claude Code has
    // no terminal here, so an allow without answers stalls the turn.
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

    // External directories are asked first, mirroring v2's own file tools.
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
      // A decline that came with a steer is the user talking to the model, so it
      // outranks the boilerplate refusal text.
      if (outcome.feedback) return { behavior: "deny", message: outcome.feedback }
      return { behavior: "deny", message: `Permission denied: ${mapped.action} ${mapped.resource}` }
    }
    return allow
  }
