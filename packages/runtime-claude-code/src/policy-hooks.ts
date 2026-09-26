export * as ClaudeCodePolicyHooks from "./policy-hooks.js"

import type { CanUseTool, HookCallback, HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodePermissions } from "./permissions.js"
import { ClaudeCodePermissionBridge } from "./permission-bridge.js"
import { ClaudeCodeQuestions } from "./questions.js"

/**
 * The host must evaluate configured and session rules without creating a permission
 * request. An `ask` belongs exclusively to canUseTool; only `deny` is mandatory
 * here. In particular, Permission.ask is NOT a read-only evaluator: it registers
 * a pending request, and Permission.assert would open a second approval dialog.
 */
export interface Ports extends ClaudeCodePermissionBridge.Ports {
  /** Commit the host mode only after the native tool successfully executes. */
  readonly commitPlanExit?: (signal: AbortSignal) => Promise<void>
  readonly policy: (
    action: string,
    resource: string,
    signal: AbortSignal,
  ) => Promise<{
    effect: "allow" | "ask" | "deny"
    message?: string
  }>
}

const INTERRUPTED = "Interrupted"
const DENIED = (action: string, resource: string) => `Permission denied: ${action} ${resource}`
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const fingerprint = (tool: string, input: Record<string, unknown>) => JSON.stringify([tool, input])
const untilAbort = async <T>(run: () => Promise<T>, signal: AbortSignal): Promise<T | "aborted"> => {
  if (signal.aborted) return "aborted"
  let detach = () => {}
  const cancelled = new Promise<"aborted">((resolve) => {
    const onAbort = () => resolve("aborted")
    signal.addEventListener("abort", onAbort, { once: true })
    detach = () => signal.removeEventListener("abort", onAbort)
  })
  try {
    return await Promise.race([run(), cancelled])
  } finally {
    detach()
  }
}

/** One instance per redsun session/runtime. Never share it across SDK sessions. */
export const make = (ports: Ports) => {
  const bridge = ClaudeCodePermissionBridge.make(ports)
  // Approval is separate from the transition: native/managed rules can still
  // reject ExitPlanMode after PreToolUse, so only PostToolUse commits it.
  const approvedExits = new Set<string>()
  const prepared = new Map<
    string,
    { input: string; decision: ClaudeCodePermissionBridge.Decision; timer: ReturnType<typeof setTimeout> }
  >()
  let nativeSessionID: string | undefined
  const clear = () => {
    for (const entry of prepared.values()) clearTimeout(entry.timer)
    prepared.clear()
    approvedExits.clear()
    nativeSessionID = undefined
  }
  const deny = (message: string): HookJSONOutput => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message },
  })
  const remember = (
    id: string,
    tool: string,
    input: Record<string, unknown>,
    decision: ClaudeCodePermissionBridge.Decision,
  ) => {
    const previous = prepared.get(id)
    if (previous) clearTimeout(previous.timer)
    const timer = setTimeout(() => prepared.delete(id), 60_000)
    timer.unref?.()
    prepared.set(id, { input: fingerprint(tool, input), decision, timer })
  }

  const preToolUse: HookCallback = async (event, toolUseID, options) => {
    if (event.hook_event_name !== "PreToolUse") return {}
    const input = event as PreToolUseHookInput
    if (nativeSessionID && nativeSessionID !== input.session_id) clear()
    nativeSessionID = input.session_id
    const toolName = input.tool_name
    const values = record(input.tool_input)
    if (options.signal.aborted) return deny(INTERRUPTED)
    const reason = ClaudeCodePermissions.policyReason(toolName, ports.agent())
    if (reason) return deny(reason)
    // A host tool served this turn enforces redsun's policy at its leaf; canUseTool still
    // checks the SDK `redsun` provenance before allowing it.
    if (ports.isDirectHostTool?.(toolName) === true) return {}

    const resources = [] as { action: string; resource: string }[]
    const external = await untilAbort(
      () => ClaudeCodePermissions.externalDirectory({ toolName, input: values, worktree: ports.worktree }),
      options.signal,
    )
    if (external === "aborted" || options.signal.aborted) return deny(INTERRUPTED)
    if (external) resources.push({ action: "external_directory", resource: external })
    resources.push(ClaudeCodePermissions.mapPermission({ toolName, input: values, worktree: ports.worktree }))
    for (const { action, resource } of resources) {
      let result: Awaited<ReturnType<Ports["policy"]>> | "aborted"
      try {
        result = await untilAbort(() => ports.policy(action, resource, options.signal), options.signal)
      } catch {
        return deny(options.signal.aborted ? INTERRUPTED : `Could not evaluate host policy: ${action} ${resource}`)
      }
      if (result === "aborted" || options.signal.aborted) return deny(INTERRUPTED)
      if (result.effect === "deny") return deny(result.message ?? DENIED(action, resource))
      if (result.effect !== "allow" && result.effect !== "ask")
        return deny(`Could not evaluate host policy: ${action} ${resource}`)
    }

    if (toolName === ClaudeCodeQuestions.TOOL_NAME && ClaudeCodeQuestions.parse(values)) {
      // Questions must reach the host even when Claude's native settings auto-
      // approve tools. Only this interactive tool uses the callback path here.
      const id = input.tool_use_id || toolUseID
      if (!id) return deny("Missing tool-use ID for question")
      const decision = await bridge(toolName, values, options)
      if (decision.behavior === "deny") return deny(decision.message)
      remember(id, toolName, values, decision)
      return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: decision.updatedInput } }
    }
    if (toolName !== ClaudeCodePermissions.EXIT_PLAN_TOOL) return {}
    const id = input.tool_use_id || toolUseID
    if (!id) return deny("Missing tool-use ID for plan approval")
    // A denied/dismissed exit stays in plan mode. The hook does not "allow":
    // native and managed rules still get their say after it returns.
    let outcome: ClaudeCodePermissionBridge.Outcome | "aborted"
    try {
      outcome = await untilAbort(() => ports.exitPlan(options.signal), options.signal)
    } catch {
      return deny(options.signal.aborted ? INTERRUPTED : ClaudeCodePermissions.PLAN_KEEP_REFINING)
    }
    if (outcome === "aborted" || options.signal.aborted) return deny(INTERRUPTED)
    // Recorded for the `plan_exit` row whatever the answer; the transition is PostToolUse's.
    ports.onPlanExit?.(id, ClaudeCodePermissionBridge.planExit(outcome))
    if (!outcome.ok) return deny(ClaudeCodePermissionBridge.keepRefining(outcome.feedback))
    remember(id, toolName, values, { behavior: "allow", updatedInput: values })
    approvedExits.add(id)
    return {}
  }

  const postToolUse: HookCallback = async (event) => {
    if (event.hook_event_name !== "PostToolUse" || event.tool_name !== ClaudeCodePermissions.EXIT_PLAN_TOOL) return {}
    if (event.session_id !== nativeSessionID || !approvedExits.delete(event.tool_use_id)) return {}
    // The native transition already happened. Reconcile the host even if the turn
    // was just cancelled, with a separate bound for closed/unresponsive sessions.
    await ports.commitPlanExit?.(AbortSignal.timeout(5_000))
    return {}
  }

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const id = options.toolUseID
    const prior = prepared.get(id)
    if (prior) {
      clearTimeout(prior.timer)
      prepared.delete(id)
      if (
        prior.input === fingerprint(toolName, input) ||
        (prior.decision.behavior === "allow" &&
          fingerprint(toolName, prior.decision.updatedInput) === fingerprint(toolName, input))
      )
        return options.signal.aborted ? { behavior: "deny", message: INTERRUPTED } : prior.decision
    }
    return bridge(toolName, input, options)
  }

  return { preToolUse, postToolUse, canUseTool, clear }
}
