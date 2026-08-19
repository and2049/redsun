export * as ClaudeCodeModes from "./modes.js"

import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"

export const PLAN_AGENT = "plan"

const MODES = new Set<string>(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])

export const parse = (value: string | undefined): PermissionMode | undefined =>
  value !== undefined && MODES.has(value) ? (value as PermissionMode) : undefined

export const permissionMode = (input: {
  readonly agentID?: string
  readonly agentMode?: string
  readonly configured?: string
  readonly worker?: string
}): PermissionMode => {
  if (input.agentID === PLAN_AGENT) return "plan"
  if (input.agentMode === "subagent" && input.worker !== undefined && input.worker !== "inherit") {
    const worker = parse(input.worker)
    if (worker) return worker
  }
  return parse(input.configured) ?? "default"
}
