export * as ClaudeCodeModes from "./modes.js"

import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"
import type { Permission } from "@opencode/schema/permission"

export const PLAN_AGENT = "plan"

const MODES = new Set<string>(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])

export const parse = (value: string | undefined): PermissionMode | undefined =>
  value !== undefined && MODES.has(value) ? (value as PermissionMode) : undefined

export const permissionMode = (input: {
  readonly agentID?: string
  readonly agentMode?: string
  readonly isWorker?: boolean
  readonly configured?: string
  readonly worker?: string
  readonly global?: Permission.Mode
}): PermissionMode => {
  if (input.agentID === PLAN_AGENT) return "plan"
  if (input.isWorker || input.agentMode === "subagent") {
    if (input.worker !== undefined && input.worker !== "inherit") {
      const worker = parse(input.worker)
      if (worker) return worker
    }
    // Workers retain their explicitly configured mode (or inherit the native
    // configuration); the main model's UI classifier selection is not inherited.
    return parse(input.configured) ?? "default"
  }
  // An explicit native plan configuration is read-only even if the global
  // selection changes. Other primary configurations are superseded by a global
  // UI mode; normal and deterministic host auto-approval use native manual.
  if (input.global && input.configured === "plan") return "plan"
  if (input.global === "native_auto") return "auto"
  if (input.global) return "default"
  return parse(input.configured) ?? "default"
}
