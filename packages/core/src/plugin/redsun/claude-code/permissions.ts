// REDSUN: bridges the Agent SDK's `canUseTool` callback onto v2's Permission
// service, so Claude Code's tool approvals render in the existing permission UI.
//
// Foreign tool names map onto v2's canonical permission actions so a user's
// rules (`shell`, `edit`, `read`, ...) apply to delegated sessions unchanged.
// V2's file tools ask with worktree-relative patterns and user rules are written
// against those, while Claude Code reports absolute paths — normalizing here is
// what makes any path rule match at all.
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

/**
 * The permission action and resource pattern for a Claude Code tool call.
 * `worktree` is the session's working directory; a file inside it is asked with
 * a relative pattern, matching how v2's own file tools ask.
 */
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
  // Unknown tools (MCP servers, BashOutput, ...) get their own action so a user
  // can allow or deny them explicitly without widening a real one.
  return { action: "claude_code", resource: input.toolName }
}

/**
 * The external-directory pattern for a file tool reaching outside the worktree,
 * or undefined when the path is inside it. Asked before the tool's own
 * permission, mirroring how v2 gates external directories.
 */
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
