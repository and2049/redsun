export * as ClaudeCodeNativeTools from "./native-tools.js"

import { fileDiff } from "../../../tool/plugin/file-diff.js"

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

export const toolName = (name: string) => TOOL_NAMES[name] ?? name

export const toolInput = (name: string, input: Record<string, unknown>): Record<string, unknown> => {
  const keys = INPUT_KEYS[name]
  if (!keys) return input
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [keys[key] ?? key, value]))
}

type DiffFile = {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

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
      : original.replace(oldString, () => newString)
  if (replaced === original) return undefined
  return { files: [fileDiff(path, original, replaced, "modified")] }
}
