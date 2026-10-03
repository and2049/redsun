export * as ClaudeCodePermissions from "./permissions.js"

import path from "node:path"
import { stat } from "node:fs/promises"
import { ClaudeCodeNativeTools } from "./native-tools.js"

const READONLY_TOOLS = new Set(["Glob", "Grep", "TodoWrite", "ListMcpResourcesTool"])
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const PATH_TOOLS = new Set([...EDIT_TOOLS, "Read"])
export const isHostTool = (name: string) => ClaudeCodeNativeTools.HOST_TOOLS.has(name)

export const isReadOnly = (toolName: string) => READONLY_TOOLS.has(toolName)

const text = (input: Record<string, unknown>, key: string) =>
  typeof input[key] === "string" && input[key] ? (input[key] as string) : undefined

export const targetPath = (toolName: string, input: Record<string, unknown>) =>
  PATH_TOOLS.has(toolName) ? (text(input, "file_path") ?? text(input, "notebook_path")) : undefined

export const policyReason = (toolName: string, agent: string | undefined): string | undefined => {
  if (toolName === ROUTED_SUBAGENT_TOOL && agent === "plan") return PLAN_DELEGATION_REFUSED
  if (SUBAGENT_TOOLS.has(toolName) && agent === COMPOSE_AGENT) return COMPOSE_SUBAGENT_REDIRECT
  return undefined
}

const toPosix = (value: string) => value.split(path.sep).join("/")

export const mapPermission = (input: {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly worktree: string
}): { action: string; resource: string } => {
  const file = targetPath(input.toolName, input.input)
  const relative = file ? toPosix(path.relative(input.worktree, path.resolve(input.worktree, file))) : undefined
  const inside = relative !== undefined && relative.length > 0 && relative !== ".." && !relative.startsWith("../")
  const pattern = inside ? relative : (file ?? "*")

  if (input.toolName === "Bash") return { action: "shell", resource: text(input.input, "command") ?? "*" }
  if (input.toolName === "Glob") return { action: "glob", resource: text(input.input, "pattern") ?? "*" }
  if (input.toolName === "Grep") return { action: "grep", resource: text(input.input, "pattern") ?? "*" }
  if (EDIT_TOOLS.has(input.toolName)) return { action: "edit", resource: pattern }
  if (input.toolName === "Read") return { action: "read", resource: pattern }
  if (input.toolName === "WebFetch") return { action: "webfetch", resource: text(input.input, "url") ?? "*" }
  if (input.toolName === "WebSearch") return { action: "websearch", resource: text(input.input, "query") ?? "*" }
  if (ClaudeCodeNativeTools.SUBAGENT_TOOLS.has(input.toolName))
    return { action: "subagent", resource: text(input.input, "subagent_type") ?? "*" }
  if (input.toolName === "AskUserQuestion") return { action: "question", resource: "*" }
  if (input.toolName === EXIT_PLAN_TOOL) return { action: "plan_exit", resource: "*" }
  if (input.toolName === "Skill") return { action: "skill", resource: text(input.input, "skill") ?? "*" }
  // Served host tools (`mcp__redsun__*`) never get here: their leaf applies the policy. A name
  // that only looks like one is an unknown tool.
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

export const PLAN_DELEGATION_REFUSED = "Plan mode is read-only. Delegate work after the plan is approved."

export const PLAN_KEEP_REFINING = "The user wants to keep refining the plan. Stay in plan mode."

/** Native tools only: a host tool's leaf authorizes its own external paths. */
export const externalDirectory = async (input: {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly worktree: string
}): Promise<string | undefined> => {
  const search = input.toolName === "Glob" || input.toolName === "Grep"
  const file = search ? text(input.input, "path") : targetPath(input.toolName, input.input)
  if (!file) return undefined
  const absolute = path.resolve(input.worktree, file)
  const relative = path.relative(input.worktree, absolute)
  if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)))
    return undefined
  if (input.toolName === "Glob") return toPosix(path.join(absolute, "*"))
  if (input.toolName === "Grep") {
    // Host grep resolves a file OR directory; glob requires a directory. A
    // lexical dirname here would authorize the wrong boundary for /other/src.
    const type = await stat(absolute).catch(() => undefined)
    if (!type || type.isDirectory()) return toPosix(path.join(absolute, "*"))
  }
  return toPosix(path.join(path.dirname(absolute), "*"))
}
