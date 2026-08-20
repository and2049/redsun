export * as CompactionExtractor from "./compaction-extractor.js"

import type { SessionMessage } from "./message.js"

export const DEFAULT_MAX_TOOL_RESULTS = 30
export const DEFAULT_KEEP_RECENT = 4

type FileState = { read: boolean; changed: boolean }

export type State = {
  task: string
  requirements: string[]
  files: Map<string, FileState>
  results: string[]
  failures: string[]
  notes: string[]
}

const READ_TOOLS = ["read", "grep", "glob", "list", "lsp"]
const CHANGE_TOOLS = ["edit", "write", "multiedit", "patch", "apply_patch"]
const PATH_KEYS = ["filePath", "path", "file", "target_file", "source_file", "target"]
const FAILURE_PATTERN = /error|failed|exception|enoent|eacces|panic/i

const shorten = (value: string, limit: number) => (value.length <= limit ? value : `${value.slice(0, limit - 3)}...`)

const pathOf = (input: Record<string, unknown>) => {
  for (const key of PATH_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value) return value
  }
}

const contentText = (content: readonly { type: string; text?: string }[] | undefined) =>
  content
    ?.flatMap((item) => (item.type === "text" && item.text ? [item.text.trim()] : []))
    .filter(Boolean)
    .join("\n") ?? ""

const assistantText = (message: SessionMessage.Assistant) =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n")

export function extract(
  messages: readonly SessionMessage.Info[],
  maxToolResults = DEFAULT_MAX_TOOL_RESULTS,
): State {
  const state: State = { task: "", requirements: [], files: new Map(), results: [], failures: [], notes: [] }
  for (const message of messages) {
    if (message.type === "user") {
      const value = message.text.trim()
      if (!value) continue
      if (!state.task) state.task = shorten(value, 500)
      else state.requirements.push(shorten(value, 350))
      continue
    }
    if (message.type !== "assistant") continue
    const note = assistantText(message)
    if (note.length >= 20 && !/^(ok|sure|let me|i'll now)\b/i.test(note)) state.notes.push(shorten(note, 500))
    for (const part of message.content) {
      if (part.type !== "tool") continue
      const input = typeof part.state.input === "object" ? (part.state.input as Record<string, unknown>) : {}
      const filepath = pathOf(input)
      if (filepath) {
        const current = state.files.get(filepath) ?? { read: false, changed: false }
        if (READ_TOOLS.includes(part.name)) current.read = true
        if (CHANGE_TOOLS.includes(part.name)) current.changed = true
        state.files.set(filepath, current)
      }
      if (part.state.status === "error") {
        state.failures.push(shorten(`${part.name}: ${part.state.error.message}`, 600))
        continue
      }
      if (part.state.status !== "completed") continue
      const output = contentText(part.state.content)
      if (!output) continue
      if (FAILURE_PATTERN.test(output.slice(0, 600))) state.failures.push(shorten(`${part.name}: ${output}`, 600))
      state.results.push(`${part.name}: ${shorten(output, 600)}`)
    }
  }
  state.requirements = state.requirements.slice(-25)
  state.results = state.results.slice(-maxToolResults)
  state.failures = state.failures.slice(-25)
  state.notes = state.notes.slice(-25)
  return state
}

export function serialize(state: State) {
  const sections: string[] = []
  if (state.task) sections.push(`## Task\n\n${state.task}`)
  if (state.requirements.length)
    sections.push(`## User Requirements\n\n${state.requirements.map((x) => `- ${x}`).join("\n")}`)
  if (state.files.size) {
    const files = Array.from(
      state.files,
      ([file, value]) => `- \`${file}\`: ${value.changed ? "changed" : "read"}${value.changed && value.read ? "; read" : ""}`,
    )
    sections.push(`## Files Touched\n\n${files.join("\n")}`)
  }
  if (state.results.length) sections.push(`## Tool Results\n\n${state.results.map((x) => `- ${x}`).join("\n")}`)
  if (state.failures.length) sections.push(`## Errors & Failures\n\n${state.failures.map((x) => `- ${x}`).join("\n")}`)
  if (state.notes.length) sections.push(`## Assistant Notes\n\n${state.notes.map((x) => `- ${x}`).join("\n")}`)
  return sections.join("\n\n")
}
