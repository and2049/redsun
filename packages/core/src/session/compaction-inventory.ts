import { SessionMessage } from "./message"

export type State = {
  task: string
  requirements: string[]
  files: Map<string, { read: boolean; changed: boolean }>
  results: string[]
  failures: string[]
  notes: string[]
}

const shorten = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 3)}...`

const pathOf = (input: Record<string, unknown>) => {
  for (const key of ["filePath", "path", "file", "target_file", "source_file", "target"]) {
    if (typeof input[key] === "string" && input[key]) return input[key]
  }
}

const toolOutput = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const mark = (state: State, file: string, kind: "read" | "changed") => {
  const current = state.files.get(file) ?? { read: false, changed: false }
  current[kind] = true
  state.files.set(file, current)
}

export function extract(messages: readonly SessionMessage.Message[], maxToolResults: number) {
  const state: State = { task: "", requirements: [], files: new Map(), results: [], failures: [], notes: [] }
  for (const message of messages) {
    if (message.type === "user") {
      const value = message.text.trim()
      if (value) {
        if (!state.task) state.task = shorten(value, 500)
        else state.requirements.push(shorten(value, 350))
      }
      for (const file of message.files ?? []) mark(state, file.name ?? file.uri, "read")
      continue
    }
    if (message.type === "shell") {
      const output = message.output.trim()
      if (!output) continue
      if (/error|failed|exception|enoent|eacces|panic/i.test(output.slice(0, 600))) {
        state.failures.push(shorten(`shell: ${output}`, 600))
      }
      state.results.push(`shell: ${shorten(output, 600)}`)
      continue
    }
    if (message.type !== "assistant") continue
    const note = message.content
      .filter((part): part is SessionMessage.AssistantText => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
    if (note.length >= 20 && !/^(ok|sure|let me|i'll now)\b/i.test(note)) state.notes.push(shorten(note, 500))
    for (const file of message.snapshot?.files ?? []) mark(state, file, "changed")
    for (const part of message.content) {
      if (part.type !== "tool" || part.state.status === "pending") continue
      const filepath = pathOf(part.state.input)
      if (filepath && ["read", "grep", "glob", "list", "lsp"].includes(part.name)) mark(state, filepath, "read")
      if (filepath && ["edit", "write", "multiedit", "patch", "apply_patch"].includes(part.name)) {
        mark(state, filepath, "changed")
      }
      if (part.state.status === "error") {
        state.failures.push(shorten(part.state.error.message, 600))
        continue
      }
      if (part.state.status !== "completed") continue
      for (const file of part.state.outputPaths ?? []) mark(state, file, "changed")
      const output = toolOutput(part.state.content).trim()
      if (!output) continue
      if (/error|failed|exception|enoent|eacces|panic/i.test(output.slice(0, 600))) {
        state.failures.push(shorten(`${part.name}: ${output}`, 600))
      }
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
  if (state.requirements.length) {
    sections.push(`## User Requirements\n\n${state.requirements.map((value) => `- ${value}`).join("\n")}`)
  }
  if (state.files.size) {
    const files = Array.from(state.files, ([file, value]) =>
      `- \`${file}\`: ${value.changed ? "changed" : "read"}${value.changed && value.read ? "; read" : ""}`,
    )
    sections.push(`## Files Touched\n\n${files.join("\n")}`)
  }
  if (state.results.length) sections.push(`## Tool Results\n\n${state.results.map((value) => `- ${value}`).join("\n")}`)
  if (state.failures.length) {
    sections.push(`## Errors & Failures\n\n${state.failures.map((value) => `- ${value}`).join("\n")}`)
  }
  if (state.notes.length) sections.push(`## Assistant Notes\n\n${state.notes.map((value) => `- ${value}`).join("\n")}`)
  return sections.join("\n\n")
}
