// REDSUN: maps Claude Code's built-in tool names and input shapes onto v2's
// native tool vocabulary.
//
// Claude Code executes its own tools, so their calls reach the transcript as
// foreign provider-executed parts named `Read`/`Edit`/`Bash`. Renaming them to
// the tools v2 already knows lets the existing renderers and permission
// vocabulary engage instead of treating every call as an unknown tool. Unlisted
// names (MCP tools, BashOutput, NotebookEdit, ...) keep their raw name.
//
// The subagent mapping needs mirrored child-session metadata, so it lives in
// translate.ts rather than here.
export * as ClaudeCodeNativeTools from "./native-tools.js"

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
}

/** The v2-native tool name for a Claude Code tool, or the raw name. */
export const toolName = (name: string) => TOOL_NAMES[name] ?? name

/** Input with keys renamed to v2's parameter names; `name` is the raw Claude Code tool name. */
export const toolInput = (name: string, input: Record<string, unknown>): Record<string, unknown> => {
  const keys = INPUT_KEYS[name]
  if (!keys) return input
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [keys[key] ?? key, value]))
}
