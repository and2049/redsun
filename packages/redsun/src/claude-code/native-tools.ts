import { formatPatch } from "diff"
import { trimDiff } from "@/tool/edit"

/**
 * Claude Code executes its own built-in tools, so their calls reach the
 * transcript as foreign provider-executed parts named `Read`/`Edit`/`Bash`.
 * This module maps those tools onto redsun's native tool names and input
 * shapes purely for display: the TUI then renders them with its native
 * frontends (consolidated read/search runs, inline edit/write rows, shell
 * output blocks) instead of one generic row per call. Unlisted names (MCP
 * tools, BashOutput, NotebookEdit, ...) keep their raw name and the generic
 * renderer.
 *
 * The Task/Agent -> `task` mapping stays in translate.ts/subagents.ts: same
 * idea, but it needs the mirrored child-session metadata this module knows
 * nothing about.
 */

const TOOL_NAMES: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  TodoWrite: "todowrite",
  Skill: "skill",
}

/** Per-tool input key renames onto redsun's native parameter names. */
const INPUT_KEYS: Record<string, Record<string, string>> = {
  Read: { file_path: "filePath" },
  Edit: { file_path: "filePath", old_string: "oldString", new_string: "newString", replace_all: "replaceAll" },
  Write: { file_path: "filePath" },
  Grep: { glob: "include" },
  Skill: { skill: "name" },
}

/** Redsun-native tool name for a Claude Code tool, or the raw name. */
export function nativeToolName(name: string): string {
  return TOOL_NAMES[name] ?? name
}

/** Input with keys renamed to redsun's parameter names; `name` is the raw Claude Code tool name. */
export function nativeToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const keys = INPUT_KEYS[name]
  if (!keys) return input
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [keys[key] ?? key, value]))
}

/**
 * Completed-state metadata synthesized so the TUI's native renderers engage:
 * the shell output block keys off `metadata.output`, the todo checklist off
 * `metadata.todos`, and the edit diff block off `metadata.diff`. `tool` is
 * the mapped native name; `toolUseResult` is the SDK user message's
 * message-level `tool_use_result` payload, when the caller has one.
 */
export function nativeResultMetadata(
  tool: string,
  input: Record<string, unknown>,
  output: string,
  toolUseResult?: unknown,
): Record<string, unknown> | undefined {
  if (tool === "bash") return { output }
  if (tool === "todowrite" && Array.isArray(input.todos)) return { todos: input.todos }
  if (tool === "edit") {
    const diff = editDiff(input, toolUseResult)
    if (diff) return { diff }
  }
  return undefined
}

interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

function patchHunks(value: unknown): PatchHunk[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const hunks: PatchHunk[] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
    const hunk = item as Record<string, unknown>
    const { oldStart, oldLines, newStart, newLines, lines } = hunk
    if (
      typeof oldStart !== "number" ||
      typeof oldLines !== "number" ||
      typeof newStart !== "number" ||
      typeof newLines !== "number" ||
      !Array.isArray(lines) ||
      !lines.every((line): line is string => typeof line === "string")
    )
      return undefined
    hunks.push({ oldStart, oldLines, newStart, newLines, lines })
  }
  return hunks
}

/**
 * Claude Code's Edit result rides the SDK user message as `tool_use_result`
 * with jsdiff-shaped `structuredPatch` hunks (Claude Code uses jsdiff too).
 * Formatting them through the same formatPatch/trimDiff pipeline the native
 * edit tool uses yields an identical `metadata.diff`, which is what
 * activates the TUI's diff block. `tool_use_result` is message-level while
 * tool_results are blocks, so a filePath mismatch (or any unexpected shape)
 * skips the diff rather than attach it to the wrong call — the part then
 * falls back to the inline edit row.
 */
function editDiff(input: Record<string, unknown>, toolUseResult: unknown): string | undefined {
  if (!toolUseResult || typeof toolUseResult !== "object" || Array.isArray(toolUseResult)) return undefined
  const result = toolUseResult as Record<string, unknown>
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined
  if (!filePath) return undefined
  if (typeof result.filePath === "string" && result.filePath !== filePath) return undefined
  const hunks = patchHunks(result.structuredPatch)
  if (!hunks) return undefined
  try {
    return trimDiff(
      formatPatch({ oldFileName: filePath, newFileName: filePath, oldHeader: undefined, newHeader: undefined, hunks }),
    )
  } catch {
    return undefined
  }
}

export * as ClaudeCodeNativeTools from "./native-tools"
