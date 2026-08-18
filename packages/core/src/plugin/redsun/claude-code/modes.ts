// REDSUN: which Claude Code permission mode a turn runs in.
//
// The CLI owns its own read-only mode, so redsun's `plan` agent maps straight
// onto the SDK's `plan` permission mode rather than being reimplemented with
// tool denies — that is the only way Bash is covered too. Because a delegated
// session sends no system prompt, config is otherwise the *only* input, which
// would make "plan" weakenable by `claude_code.permission_mode`. It must not be:
// a user who has set `bypassPermissions` globally still expects the plan agent
// to look and not touch.
//
// Pure on purpose — the agent lookup is async, so provider.ts resolves the
// agent's mode and calls this.
export * as ClaudeCodeModes from "./modes.js"

import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"

/** The redsun agent whose read-only contract the CLI enforces for us. */
export const PLAN_AGENT = "plan"

const MODES = new Set<string>(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])

/** A configured mode string, or undefined when it is absent or not a real mode. */
export const parse = (value: string | undefined): PermissionMode | undefined =>
  value !== undefined && MODES.has(value) ? (value as PermissionMode) : undefined

export const permissionMode = (input: {
  /** The agent driving this turn, if one has been recorded yet. */
  readonly agentID?: string
  /** That agent's `mode`, resolved from the agent registry. */
  readonly agentMode?: string
  /** `claude_code.permission_mode`. */
  readonly configured?: string
  /** `claude_code.worker_permission_mode`; `"inherit"` (the default) defers. */
  readonly worker?: string
}): PermissionMode => {
  // Unweakenable: config is deliberately not consulted on this branch.
  if (input.agentID === PLAN_AGENT) return "plan"
  if (input.agentMode === "subagent" && input.worker !== undefined && input.worker !== "inherit") {
    const worker = parse(input.worker)
    if (worker) return worker
  }
  return parse(input.configured) ?? "default"
}
