// REDSUN: maps Claude Code's built-in tool names, input shapes, and result
// metadata onto v2's native tool vocabulary.
//
// Claude Code executes its own tools, so their calls reach the transcript as
// foreign provider-executed parts named `Read`/`Edit`/`Bash`. Renaming them to
// the tools v2 already knows lets the existing renderers and permission
// vocabulary engage instead of treating every call as an unknown tool. Unlisted
// names (MCP tools, BashOutput, NotebookEdit, ...) keep their raw name.
//
// A renamed tool still renders as a bare row until its *result* carries what
// the renderer reads, so `resultMetadata` re-derives the one thing v2 keeps in
// metadata rather than input: an edit's diff.
//
// The subagent mapping needs mirrored child-session metadata, so it lives in
// translate.ts rather than here.
export * as ClaudeCodeNativeTools from "./native-tools.js"

import { fileDiff } from "../../../tool/plugin/file-diff.js"

/** Claude Code's subagent tool: `Task` on older CLIs, `Agent` on current ones. */
export const SUBAGENT_TOOLS = new Set(["Task", "Agent"])

const TOOL_NAMES: Record<string, string> = {
  Bash: "shell",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  Skill: "skill",
}

/** Per-tool input key renames onto v2's parameter names. */
const INPUT_KEYS: Record<string, Record<string, string>> = {
  Read: { file_path: "path" },
  Edit: {
    file_path: "path",
    old_string: "oldString",
    new_string: "newString",
    replace_all: "replaceAll",
  },
  Write: { file_path: "path" },
  Grep: { glob: "include" },
  Skill: { skill: "id" },
}

/** The v2-native tool name for a Claude Code tool, or the raw name. */
export const toolName = (name: string) => TOOL_NAMES[name] ?? name

/** Input with keys renamed to v2's parameter names; `name` is the raw Claude Code tool name. */
export const toolInput = (name: string, input: Record<string, unknown>): Record<string, unknown> => {
  const keys = INPUT_KEYS[name]
  if (!keys) return input
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [keys[key] ?? key, value]))
}

/**
 * `FileDiff.Info` restated as a type alias. The stream part's `result` is typed
 * `JSONValue`, and TypeScript only infers an implicit index signature for an
 * alias -- the schema's interface would not assign.
 */
type DiffFile = {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * Completed-state metadata synthesized so the native renderers engage.
 *
 * v2's edit and write renderers key off `metadata.files` -- an array of
 * `FileDiff.Info` -- and fall back to a bare path row with no diff when it is
 * absent, so a delegated edit would show less than a generic tool call does.
 * Claude Code reports the same facts on the SDK user message's message-level
 * `tool_use_result`: the file's pre-edit content plus the edit that was
 * applied. Re-deriving the patch through `fileDiff`, the helper the native edit
 * tool itself uses, yields a byte-identical `FileDiff.Info` -- so a delegated
 * edit renders exactly like a native one rather than merely similarly.
 *
 * `tool_use_result` is message-level while tool results are blocks, so a
 * `filePath` mismatch -- or any unexpected shape -- yields no metadata rather
 * than attaching a diff to the wrong call.
 *
 * `name` is the mapped v2 tool name and `input` the mapped input, both as
 * `toolName`/`toolInput` produced them.
 */
export const resultMetadata = (
  name: string,
  input: Record<string, unknown>,
  toolUseResult: unknown,
): { files: DiffFile[] } | undefined => {
  if (name !== "edit" && name !== "write") return undefined
  const result = record(toolUseResult)
  if (!result) return undefined
  const path = typeof input.path === "string" ? input.path : undefined
  if (!path) return undefined
  if (typeof result.filePath === "string" && result.filePath !== path) return undefined
  const original = typeof result.originalFile === "string" ? result.originalFile : undefined

  if (name === "write") {
    if (typeof result.content !== "string") return undefined
    const status = result.type === "create" || original === undefined ? "added" : "modified"
    return { files: [fileDiff(path, original ?? "", result.content, status)] }
  }

  if (original === undefined) return undefined
  const oldString = typeof result.oldString === "string" ? result.oldString : undefined
  const newString = typeof result.newString === "string" ? result.newString : undefined
  if (!oldString || newString === undefined) return undefined
  const replaced =
    result.replaceAll === true
      ? original.split(oldString).join(newString)
      : // A string pattern makes `$&` and `$1` in the replacement expand, so the
        // replacement goes through a function.
        original.replace(oldString, () => newString)
  if (replaced === original) return undefined
  return { files: [fileDiff(path, original, replaced, "modified")] }
}
