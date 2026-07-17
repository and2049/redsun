import { SessionV1 } from "@opencode-ai/core/v1/session"

export namespace CompactionExtractor {
  export const DEFAULT_MAX_TOOL_RESULTS = 30
  type FileState = { read: boolean; changed: boolean }
  export type State = {
    task: string
    requirements: string[]
    files: Map<string, FileState>
    results: string[]
    failures: string[]
    notes: string[]
  }

  const text = (message: SessionV1.WithParts) =>
    message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !("synthetic" in part && part.synthetic))
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")

  const shorten = (value: string, limit: number) =>
    value.length <= limit ? value : `${value.slice(0, limit - 3)}...`

  const pathOf = (input: Record<string, unknown>) => {
    for (const key of ["filePath", "path", "file", "target_file", "source_file", "target"]) {
      if (typeof input[key] === "string" && input[key]) return input[key]
    }
  }

  export function extract(messages: SessionV1.WithParts[], maxToolResults = DEFAULT_MAX_TOOL_RESULTS): State {
    const state: State = { task: "", requirements: [], files: new Map(), results: [], failures: [], notes: [] }
    for (const message of messages) {
      if (message.info.role === "user") {
        if (message.parts.some((part) => part.type === "compaction")) continue
        const value = text(message)
        if (!value) continue
        if (!state.task) state.task = shorten(value, 500)
        else state.requirements.push(shorten(value, 350))
        continue
      }
      if (message.info.role !== "assistant" || message.info.summary) continue
      const note = text(message)
      if (note.length >= 20 && !/^(ok|sure|let me|i'll now)\b/i.test(note)) state.notes.push(shorten(note, 500))
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        const input = (part.state.input ?? {}) as Record<string, unknown>
        const filepath = pathOf(input)
        if (filepath) {
          const current = state.files.get(filepath) ?? { read: false, changed: false }
          if (["read", "grep", "glob", "list", "lsp"].includes(part.tool)) current.read = true
          if (["edit", "write", "multiedit", "patch", "apply_patch"].includes(part.tool)) current.changed = true
          state.files.set(filepath, current)
        }
        if (part.state.status === "error") {
          state.failures.push(shorten(part.state.error, 600))
          continue
        }
        if (part.state.status !== "completed") continue
        const output = part.state.output?.trim()
        if (!output) continue
        if (/error|failed|exception|enoent|eacces|panic/i.test(output.slice(0, 600))) {
          state.failures.push(shorten(`${part.tool}: ${output}`, 600))
        }
        state.results.push(`${part.tool}: ${shorten(output, 600)}`)
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
    if (state.requirements.length) sections.push(`## User Requirements\n\n${state.requirements.map((x) => `- ${x}`).join("\n")}`)
    if (state.files.size) {
      const files = Array.from(state.files, ([file, value]) =>
        `- \`${file}\`: ${value.changed ? "changed" : "read"}${value.changed && value.read ? "; read" : ""}`,
      )
      sections.push(`## Files Touched\n\n${files.join("\n")}`)
    }
    if (state.results.length) sections.push(`## Tool Results\n\n${state.results.map((x) => `- ${x}`).join("\n")}`)
    if (state.failures.length) sections.push(`## Errors & Failures\n\n${state.failures.map((x) => `- ${x}`).join("\n")}`)
    if (state.notes.length) sections.push(`## Assistant Notes\n\n${state.notes.map((x) => `- ${x}`).join("\n")}`)
    return sections.join("\n\n")
  }

  export function recent(messages: SessionV1.WithParts[], count: number) {
    return count <= 0 ? [] : messages.slice(-count)
  }
}
