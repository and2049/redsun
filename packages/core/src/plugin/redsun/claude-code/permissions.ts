export * as ClaudeCodePermissions from "./permissions.js"

import path from "node:path"
import { ClaudeCodeNativeTools } from "./native-tools.js"

const READONLY_TOOLS = new Set(["Glob", "Grep", "TodoWrite", "ListMcpResourcesTool"])
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const PATH_TOOLS = new Set([...EDIT_TOOLS, "Read"])

export const isReadOnly = (toolName: string) => READONLY_TOOLS.has(toolName)

const text = (input: Record<string, unknown>, key: string) =>
  typeof input[key] === "string" && input[key] ? (input[key] as string) : undefined

export const targetPath = (toolName: string, input: Record<string, unknown>) =>
  PATH_TOOLS.has(toolName) ? (text(input, "file_path") ?? text(input, "notebook_path")) : undefined

const toPosix = (value: string) => value.split(path.sep).join("/")

export const mapPermission = (input: {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly worktree: string
}): { action: string; resource: string } => {
  const file = targetPath(input.toolName, input.input)
  const relative = file ? toPosix(path.relative(input.worktree, file)) : undefined
  const inside = relative !== undefined && relative.length > 0 && !relative.startsWith("..")
  const pattern = inside ? relative : (file ?? "*")

  if (input.toolName === "Bash") return { action: "shell", resource: text(input.input, "command") ?? "*" }
  if (EDIT_TOOLS.has(input.toolName)) return { action: "edit", resource: pattern }
  if (input.toolName === "Read") return { action: "read", resource: pattern }
  if (input.toolName === "WebFetch") return { action: "webfetch", resource: text(input.input, "url") ?? "*" }
  if (input.toolName === "WebSearch") return { action: "websearch", resource: text(input.input, "query") ?? "*" }
  if (ClaudeCodeNativeTools.SUBAGENT_TOOLS.has(input.toolName))
    return { action: "subagent", resource: text(input.input, "subagent_type") ?? "*" }
  if (input.toolName === "AskUserQuestion") return { action: "question", resource: "*" }
  return { action: "claude_code", resource: input.toolName }
}

export const COMPOSE_SUBAGENT_REDIRECT =
  "Use the `mcp__redsun__subagent` tool instead of the native subagent tool. " +
  "Compose delegates through redsun so worker model selection, depth limits, " +
  "and background runs apply."

export const COMPOSE_AGENT = "compose"

export const SUBAGENT_TOOLS = ClaudeCodeNativeTools.SUBAGENT_TOOLS

export const ROUTED_SUBAGENT_TOOL = "mcp__redsun__subagent"

export const EXIT_PLAN_TOOL = "ExitPlanMode"

export const PLAN_DELEGATION_REFUSED =
  "Plan mode is read-only. Delegate work after the plan is approved."

export const PLAN_KEEP_REFINING = "The user wants to keep refining the plan. Stay in plan mode."

export const externalDirectory = (input: {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly worktree: string
}): string | undefined => {
  const file = targetPath(input.toolName, input.input)
  if (!file) return undefined
  const relative = path.relative(input.worktree, file)
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) return undefined
  return toPosix(path.join(path.dirname(file), "*"))
}
