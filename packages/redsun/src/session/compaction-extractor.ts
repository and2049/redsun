import { MessageV2 } from "./message-v2"
import { Todo } from "./todo"

export namespace CompactionExtractor {
  const MAX_LIST_SIZE = 25
  export const DEFAULT_MAX_TOOL_RESULTS = 30
  const TASK_TRUNCATE = 400
  const REQUIREMENT_TRUNCATE = 300
  const NOTE_TRUNCATE = 300
  const NOTE_MIN_TURN_LEN = 20
  const TOOL_RESULT_TRUNCATE = 600
  const ERROR_RESULT_TRUNCATE = 1500
  const EDIT_DETAIL_TRUNCATE = 300
  const CMD_TRUNCATE = 200
  const SHELL_RESULT_TRUNCATE = 800
  const ERROR_SCAN_LEN = 500
  const ERROR_SUMMARY_TRUNCATE = 300
  const FILE_PATH_KEYS = ["filePath", "path", "file", "target_file", "source_file", "target"] as const

  const READ_TOOLS = new Set(["read", "grep", "glob", "codesearch", "list", "lsp"])
  const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "patch"])
  const SHELL_TOOLS = new Set(["bash", "project"])
  const WEB_TOOLS = new Set(["webfetch", "websearch"])
  const TODO_TOOLS = new Set(["todowrite", "todoread"])

  const ERROR_REGEX = /error|Error|ERROR|failed|FAILED|exception|EXCEPTION|not found|ENOENT|EACCES|panic/i
  const FILLER_REGEX = /^(ok|sure|let me|i'll now|here's|looking at|alright|got it|understood)/i
  const SENTENCE_SPLIT = /(?<=[.!?])\s+/

  export type FileAction =
    | { type: "read"; summary: string }
    | { type: "edit"; detail: string }
    | { type: "create"; detail: string }

  export interface FileSlot {
    path: string
    actions: FileAction[]
  }

  export interface ToolResultSlot {
    tool: string
    summary: string
  }

  export interface WorkingState {
    task: string
    userRequirements: string[]
    files: Map<string, FileSlot>
    toolResults: ToolResultSlot[]
    failures: string[]
    assistantNotes: string[]
    todoState: Todo.Info[]
    patches: { hash: string; files: string[] }[]
  }

  export interface ExtractOptions {
    maxToolResults?: number
  }

  export function createState(): WorkingState {
    return {
      task: "",
      userRequirements: [],
      files: new Map(),
      toolResults: [],
      failures: [],
      assistantNotes: [],
      todoState: [],
      patches: [],
    }
  }

  function addCapped(list: string[], item: string, max = MAX_LIST_SIZE) {
    list.push(item)
    while (list.length > max) list.shift()
  }

  function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 3) + "..." : s
  }

  function extractFilePath(input: Record<string, any>): string | undefined {
    for (const key of FILE_PATH_KEYS) {
      const val = input[key]
      if (typeof val === "string" && val.length > 0) return val
    }
    return undefined
  }

  function extractFileOutline(text: string): string | undefined {
    const symbols: string[] = []
    const patterns = [
      /export\s+(?:async\s+)?(?:function|class|const|let|type|interface|enum)\s+(\w+)/g,
      /(?:function|class)\s+(\w+)/g,
      /(?:def|class)\s+(\w+)/g,
    ]
    for (const pattern of patterns) {
      let m: RegExpExecArray | null
      while ((m = pattern.exec(text)) !== null) {
        if (!symbols.includes(m[1])) symbols.push(m[1])
      }
    }
    if (symbols.length === 0) return undefined
    const display = symbols.slice(0, 8)
    const suffix = symbols.length > 8 ? ` +${symbols.length - 8} more` : ""
    return `exports: ${display.join(", ")}${suffix}`
  }

  function isErrorResult(output: string): boolean {
    return ERROR_REGEX.test(output.slice(0, ERROR_SCAN_LEN))
  }

  function extractErrorSummary(output: string): string {
    const lines = output.split("\n")
    for (const line of lines) {
      if (ERROR_REGEX.test(line)) return truncate(line.trim(), ERROR_SUMMARY_TRUNCATE)
    }
    return truncate(lines[0]?.trim() ?? "", ERROR_SUMMARY_TRUNCATE)
  }

  function buildReadSummary(tool: string, input: Record<string, any>): string {
    if (tool === "grep") return `grep for "${truncate(input.pattern ?? "", 100)}"`
    if (tool === "glob") return `glob "${truncate(input.pattern ?? "", 100)}"`
    if (tool === "codesearch") return `code search: ${truncate(input.query ?? "", 100)}`
    if (tool === "list") return `list ${truncate(input.path ?? ".", 80)}`
    if (tool === "lsp") return `lsp: ${truncate(input.operation ?? "", 80)}`
    return `read ${truncate(input.filePath ?? "", 100)}`
  }

  function buildEditDetail(tool: string, input: Record<string, any>): string {
    if (tool === "write") {
      const lines = (input.content ?? "").split("\n").length
      return `full write (${lines} lines)`
    }
    if (tool === "multiedit") {
      const edits = Array.isArray(input.edits) ? input.edits : []
      if (edits.length > 0) {
        const first = edits[0]
        const oldStr = first.oldString ?? ""
        const newStr = first.newString ?? ""
        return `${edits.length} edits, first: "${truncate(oldStr, EDIT_DETAIL_TRUNCATE)}" → "${truncate(newStr, EDIT_DETAIL_TRUNCATE)}"`
      }
      return `multi-edit ${truncate(input.filePath ?? "", 100)}`
    }
    if (tool === "patch") {
      const patchLines = (input.patchText ?? "").split("\n").length
      return `patch (${patchLines} lines)`
    }
    const oldStr = input.oldString ?? input.find ?? ""
    const newStr = input.newString ?? input.replace ?? ""
    if (oldStr && newStr) {
      return `"${truncate(oldStr, EDIT_DETAIL_TRUNCATE)}" → "${truncate(newStr, EDIT_DETAIL_TRUNCATE)}"`
    }
    return `edit ${truncate(input.filePath ?? "", 100)}`
  }

  function isSubstantive(sentence: string): boolean {
    if (sentence.length < 15) return false
    if (FILLER_REGEX.test(sentence.trim())) return false
    return true
  }

  function extractUserText(msg: MessageV2.WithParts): string {
    const texts: string[] = []
    for (const part of msg.parts) {
      if (part.type === "text" && !part.synthetic) texts.push(part.text)
    }
    return texts.join("\n").trim()
  }

  function extractAssistantText(msg: MessageV2.WithParts): string {
    const texts: string[] = []
    for (const part of msg.parts) {
      if (part.type === "text") texts.push(part.text)
    }
    return texts.join("\n").trim()
  }

  function trackFile(state: WorkingState, filePath: string, action: FileAction) {
    if (!filePath) return
    let slot = state.files.get(filePath)
    if (!slot) {
      slot = { path: filePath, actions: [] }
      state.files.set(filePath, slot)
    }
    if (action.type === "read") {
      const lastRead = [...slot.actions].reverse().find((a) => a.type === "read")
      if (lastRead && lastRead.type === "read" && action.summary) {
        lastRead.summary = action.summary
        return
      }
    }
    slot.actions.push(action)
  }

  function addToolResult(state: WorkingState, tool: string, summary: string, maxToolResults = DEFAULT_MAX_TOOL_RESULTS) {
    const last = state.toolResults[state.toolResults.length - 1]
    if (last && last.tool === tool) {
      last.summary = truncate(`${last.summary} → ${summary}`, SHELL_RESULT_TRUNCATE)
    } else {
      state.toolResults.push({ tool, summary: truncate(summary, TOOL_RESULT_TRUNCATE) })
      while (state.toolResults.length > maxToolResults) state.toolResults.shift()
    }
  }

  function extractFromToolCall(state: WorkingState, part: MessageV2.ToolPart, options: ExtractOptions) {
    const tool = part.tool
    const input = part.state.input ?? {}
    const maxToolResults = options.maxToolResults ?? DEFAULT_MAX_TOOL_RESULTS

    if (READ_TOOLS.has(tool)) {
      const filePath = extractFilePath(input)
      if (filePath) trackFile(state, filePath, { type: "read", summary: buildReadSummary(tool, input) })
      return
    }

    if (EDIT_TOOLS.has(tool)) {
      const filePath = extractFilePath(input)
      if (filePath) {
        const isCreate = tool === "write" && !(state.files.get(filePath)?.actions.some((a) => a.type === "read"))
        trackFile(state, filePath, {
          type: isCreate ? "create" : "edit",
          detail: buildEditDetail(tool, input),
        })
      } else if (tool === "patch") {
        addToolResult(state, "patch", buildEditDetail(tool, input), maxToolResults)
      }
      return
    }

    if (SHELL_TOOLS.has(tool)) {
      if (tool === "bash") {
        addToolResult(state, "bash", `ran: ${truncate(input.command ?? "", CMD_TRUNCATE)}`, maxToolResults)
      } else if (tool === "project") {
        addToolResult(state, "project", `${truncate(input.action ?? "run", 80)}: ${truncate(input.file ?? "", 80)}`, maxToolResults)
      }
      return
    }

    if (WEB_TOOLS.has(tool)) {
      const query = input.query ?? input.url ?? ""
      addToolResult(state, tool, truncate(query, 100), maxToolResults)
      return
    }

    if (TODO_TOOLS.has(tool)) {
      if (tool === "todowrite" && Array.isArray(input.todos)) {
        state.todoState = input.todos as Todo.Info[]
      }
      return
    }

    if (tool === "task") {
      addToolResult(state, "task", `dispatch: ${truncate(input.description ?? input.prompt ?? "", 100)}`, maxToolResults)
      return
    }
  }

  function extractFromToolResult(state: WorkingState, part: MessageV2.ToolPart, options: ExtractOptions) {
    const maxToolResults = options.maxToolResults ?? DEFAULT_MAX_TOOL_RESULTS
    if (part.state.status === "error") {
      addCapped(state.failures, truncate(part.state.error, ERROR_RESULT_TRUNCATE))
      return
    }
    if (part.state.status !== "completed") return

    const tool = part.tool
    const output = part.state.modelOutput ?? part.state.output ?? ""

    if (SHELL_TOOLS.has(tool) && isErrorResult(output)) {
      addCapped(state.failures, `${tool}: ${extractErrorSummary(output)}`)
    }

    if (SHELL_TOOLS.has(tool)) {
      const last = state.toolResults[state.toolResults.length - 1]
      if (last && last.tool === tool) {
        const limit = isErrorResult(output) ? ERROR_RESULT_TRUNCATE : SHELL_RESULT_TRUNCATE
        last.summary = truncate(`${last.summary} → ${truncate(output.trim(), limit)}`, limit)
      } else {
        addToolResult(state, tool, truncate(output.trim(), SHELL_RESULT_TRUNCATE), maxToolResults)
      }
      return
    }

    if (tool === "grep" || tool === "codesearch") {
      const lines = output.split("\n").filter((l) => l.trim().length > 0)
      const preview = lines.slice(0, 10).join("\n")
      addToolResult(state, tool, `${lines.length} matches:\n${truncate(preview, TOOL_RESULT_TRUNCATE)}`, maxToolResults)
      return
    }

    if (tool === "read") {
      const filePath = extractFilePath(part.state.input ?? {})
      if (filePath) {
        const outline = extractFileOutline(output)
        const lineCount = output.split("\n").length
        const summary = outline ? `${lineCount} lines — ${outline}` : `${lineCount} lines`
        trackFile(state, filePath, { type: "read", summary })
      }
      return
    }

    if (WEB_TOOLS.has(tool)) {
      addToolResult(state, tool, truncate(output.trim(), TOOL_RESULT_TRUNCATE), maxToolResults)
      return
    }

    if (tool === "task") {
      addToolResult(state, "task", truncate(output.trim(), TOOL_RESULT_TRUNCATE), maxToolResults)
      return
    }
  }

  function extractFromUserMessage(state: WorkingState, msg: MessageV2.WithParts) {
    const text = extractUserText(msg)
    if (!text) return
    if (!state.task) {
      state.task = truncate(text, TASK_TRUNCATE)
    } else {
      addCapped(state.userRequirements, truncate(text, REQUIREMENT_TRUNCATE))
    }
  }

  function extractFromAssistantMessage(state: WorkingState, msg: MessageV2.WithParts) {
    const text = extractAssistantText(msg)
    if (text.length < NOTE_MIN_TURN_LEN) return

    const sentences = text.split(SENTENCE_SPLIT).filter((s) => s.trim().length > 0)
    if (sentences.length <= 3) {
      addCapped(state.assistantNotes, truncate(text.trim(), NOTE_TRUNCATE))
      return
    }

    const substantive = sentences.filter(isSubstantive)
    const selected = substantive.slice(0, 5)
    const budget = selected.join(" ")
    addCapped(state.assistantNotes, truncate(budget, 500))
  }

  function extractFromPatch(state: WorkingState, part: MessageV2.PatchPart) {
    state.patches.push({ hash: part.hash, files: part.files })
  }

  export function extract(messages: MessageV2.WithParts[], options: ExtractOptions = {}): WorkingState {
    const state = createState()

    for (const msg of messages) {
      if (msg.info.role === "user") {
        const hasCompaction = msg.parts.some((p) => p.type === "compaction")
        if (hasCompaction) continue
        extractFromUserMessage(state, msg)
        continue
      }

      if (msg.info.role === "assistant") {
        if (msg.info.summary) continue
        for (const part of msg.parts) {
          if (part.type === "tool") {
            extractFromToolCall(state, part, options)
            extractFromToolResult(state, part, options)
          } else if (part.type === "patch") {
            extractFromPatch(state, part)
          }
        }
        extractFromAssistantMessage(state, msg)
      }
    }

    return state
  }

  export function slotCount(state: WorkingState): number {
    return (
      (state.task ? 1 : 0) +
      state.files.size +
      state.toolResults.length +
      state.failures.length +
      state.assistantNotes.length +
      state.userRequirements.length +
      state.todoState.length +
      state.patches.length
    )
  }

  export function serialize(state: WorkingState): string {
    const sections: string[] = []

    if (state.task) {
      sections.push(`## Task\n\n${state.task}`)
    }

    if (state.userRequirements.length > 0) {
      sections.push(`## User Requirements\n\n${state.userRequirements.map((r) => `- ${r}`).join("\n")}`)
    }

    if (state.files.size > 0) {
      const lines: string[] = []
      for (const [p, slot] of state.files) {
        const parts = slot.actions.map((a) => {
          if (a.type === "read") return `read: ${a.summary}`
          if (a.type === "create") return `created: ${a.detail}`
          return `edited: ${a.detail}`
        })
        lines.push(`- \`${p}\`: ${parts.join("; ")}`)
      }
      sections.push(`## Files Touched\n\n${lines.join("\n")}`)
    }

    if (state.toolResults.length > 0) {
      const lines = state.toolResults.map((r) => `- **${r.tool}**: ${r.summary}`)
      sections.push(`## Tool Results\n\n${lines.join("\n")}`)
    }

    if (state.failures.length > 0) {
      sections.push(`## Errors & Failures\n\n${state.failures.map((f) => `- ${f}`).join("\n")}`)
    }

    if (state.todoState.length > 0) {
      const lines = state.todoState.map((t) => `- [${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : t.status === "cancelled" ? "~" : " "}] ${t.content} (${t.priority})`)
      sections.push(`## TODO State\n\n${lines.join("\n")}`)
    }

    if (state.assistantNotes.length > 0) {
      sections.push(`## Assistant Notes\n\n${state.assistantNotes.map((n) => `- ${n}`).join("\n")}`)
    }

    if (state.patches.length > 0) {
      const allFiles = [...new Set(state.patches.flatMap((p) => p.files))]
      sections.push(`## File Changes\n\n${allFiles.length} files changed across ${state.patches.length} steps`)
    }

    return sections.join("\n\n")
  }

  export function extractRecentMessages(messages: MessageV2.WithParts[], keepRecent: number): MessageV2.WithParts[] {
    if (messages.length <= keepRecent) return messages
    let split = messages.length - keepRecent
    while (split > 0 && split < messages.length - 1) {
      const msg = messages[split]
      if (msg.info.role === "assistant") {
        const hasToolCall = msg.parts.some((p) => p.type === "tool" && p.state.status !== "error")
        if (hasToolCall) {
          split--
          continue
        }
      }
      break
    }
    split = Math.max(0, split)
    return messages.slice(split)
  }
}
