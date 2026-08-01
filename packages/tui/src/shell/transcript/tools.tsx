// Dense per-tool scrollback writers: `⏺ Name(args)` header plus a muted
// `  ⎿  ` result gutter, one record per settled tool call.
//
// Ports the presentation of the classic renderers
// (routes/session/index.tsx:2116-2662) into one-shot scrollback writers.
// Writers render OUTSIDE the app's Solid context tree, so everything they
// need — theme, syntax style, path formatting — arrives via ToolWriterContext.
// Diffs commit as unified views with transparent backgrounds (the --mini
// suppressBackgrounds precedent) so committed rows read cleanly over any
// terminal background.
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { RGBA, type ScrollbackWriter, type SyntaxStyle } from "@opentui/core"
import { createScrollbackWriter } from "@opentui/solid"
import type { JSX } from "solid-js"
import stripAnsi from "strip-ansi"
import {
  formatCompletedSubagentDetail,
  parseApplyPatchFiles,
  parseDiagnostics,
  parseQuestionAnswers,
  parseQuestions,
  parseTodos,
} from "../../routes/session/index"
import type { Theme } from "../../theme"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { filetype } from "../../util/filetype"
import * as Locale from "../../util/locale"
import { webSearchProviderLabel } from "../../util/tool-display"
import type { TaskDetail } from "./blocks"

export type ToolWriterContext = {
  theme: Theme
  syntax: SyntaxStyle
  formatPath: (input?: string) => string
  normalizePath: (input: string) => string
  diffWrapMode: "word" | "none"
}

const transparent = RGBA.fromValues(0, 0, 0, 0)

type GutterLine = { text: string; fg?: RGBA }

type ToolRecord = {
  name: string
  arg?: string
  lines: GutterLine[]
  rich?: () => JSX.Element
}

// ---------------------------------------------------------------------------
// Value helpers (duplicated from the file-private helpers in
// routes/session/index.tsx:2690-2705 — they are not exported there).

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function inlineArgs(input: Record<string, unknown>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function stateInput(part: ToolPart): Record<string, unknown> {
  return recordValue((part.state as { input?: unknown }).input) ?? {}
}

function stateMetadata(part: ToolPart): Record<string, unknown> {
  return recordValue((part.state as { metadata?: unknown }).metadata) ?? {}
}

function stateOutput(part: ToolPart): string | undefined {
  return part.state.status === "completed" ? part.state.output : undefined
}

function plural(count: number, word: string): string {
  if (count === 1) return `1 ${word}`
  return `${count} ${word}${/(?:s|x|z|ch|sh)$/.test(word) ? "es" : "s"}`
}

function diagnosticLines(input: {
  metadata: Record<string, unknown>
  filePath?: string
  ctx: ToolWriterContext
}): GutterLine[] {
  if (!input.filePath) return []
  return parseDiagnostics(input.metadata.diagnostics, input.ctx.normalizePath(input.filePath)).map((diagnostic) => ({
    text: `Error [${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}] ${diagnostic.message}`,
    fg: input.ctx.theme.error,
  }))
}

function todoText(item: { status: string; content: string }): string {
  if (item.status === "completed") return `[✓] ${item.content}`
  if (item.status === "cancelled") return `~[ ] ${item.content}~`
  if (item.status === "in_progress") return `[•] ${item.content}`
  return `[ ] ${item.content}`
}

type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    const item = recordValue(call)
    const tool = stringValue(item?.tool)
    const status = stringValue(item?.status)
    if (!tool || !status || !["running", "completed", "error"].includes(status)) return []
    return [{ tool, status: status as ExecuteCall["status"], input: recordValue(item?.input) }]
  })
}

// ---------------------------------------------------------------------------
// Per-tool records. Only settled (completed/error) parts reach the writers.

function describeBash(part: ToolPart, ctx: ToolWriterContext, width: number): ToolRecord {
  const input = stateInput(part)
  const metadata = stateMetadata(part)
  const lines: GutterLine[] = []

  const workdir = stringValue(input.workdir)
  if (workdir && workdir !== ".") {
    const formatted = ctx.formatPath(workdir)
    if (formatted !== ".") lines.push({ text: `in ${formatted}` })
  }

  const output = stripAnsi(stringValue(metadata.output)?.trim() ?? "")
  if (output) {
    const collapsed = collapseToolOutput(output, 10, 10 * Math.max(20, width - 6))
    for (const line of collapsed.output.split("\n")) lines.push({ text: line })
  } else if (part.state.status === "completed") {
    lines.push({ text: "(no output)" })
  }

  return { name: "Bash", arg: stringValue(input.command), lines }
}

function describeWrite(part: ToolPart, ctx: ToolWriterContext): ToolRecord {
  const input = stateInput(part)
  const metadata = stateMetadata(part)
  const filePath = stringValue(input.filePath)
  const lines: GutterLine[] = []

  if (part.state.status === "completed") {
    const content = stringValue(input.content) ?? ""
    const count = content ? content.split("\n").length : 0
    lines.push({ text: `Wrote ${plural(count, "line")}` })
  }
  lines.push(...diagnosticLines({ metadata, filePath, ctx }))

  return { name: "Write", arg: ctx.formatPath(filePath), lines }
}

function describeEdit(part: ToolPart, ctx: ToolWriterContext): ToolRecord {
  const input = stateInput(part)
  const metadata = stateMetadata(part)
  const filePath = stringValue(input.filePath)
  const diff = stringValue(metadata.diff)

  return {
    name: "Edit",
    arg: ctx.formatPath(filePath),
    lines: diagnosticLines({ metadata, filePath, ctx }),
    rich: diff ? () => <DiffView diff={diff} file={filePath} ctx={ctx} /> : undefined,
  }
}

function describeApplyPatch(part: ToolPart, ctx: ToolWriterContext): ToolRecord {
  const metadata = stateMetadata(part)
  const files = parseApplyPatchFiles(metadata.files)
  if (files.length === 0) return { name: "Patch", lines: [] }

  function title(file: (typeof files)[number]) {
    if (file.type === "delete") return `Deleted ${file.relativePath}`
    if (file.type === "add") return `Created ${file.relativePath}`
    if (file.type === "move") return `Moved ${ctx.formatPath(file.filePath)} → ${file.relativePath}`
    return `Patched ${file.relativePath}`
  }

  return {
    name: "Patch",
    arg: files.length === 1 ? files[0].relativePath : plural(files.length, "file"),
    lines: [],
    rich: () => (
      <box width="100%" flexDirection="column">
        {files.map((file) => (
          <box width="100%" flexDirection="column">
            <text width="100%" wrapMode="word" fg={ctx.theme.textMuted}>
              {title(file)}
            </text>
            {file.type === "delete" ? (
              <text width="100%" wrapMode="word" fg={ctx.theme.diffRemoved}>
                -{plural(file.deletions, "line")}
              </text>
            ) : (
              <>
                <DiffView diff={file.patch} file={file.filePath} ctx={ctx} />
                {diagnosticLines({ metadata, filePath: file.movePath ?? file.filePath, ctx }).map((line) => (
                  <text width="100%" wrapMode="word" fg={line.fg}>
                    {line.text}
                  </text>
                ))}
              </>
            )}
          </box>
        ))}
      </box>
    ),
  }
}

function describeRead(part: ToolPart, ctx: ToolWriterContext): ToolRecord {
  const input = stateInput(part)
  const metadata = stateMetadata(part)
  const filePath = stringValue(input.filePath)
  const extra = inlineArgs(input, ["filePath"])

  const lines: GutterLine[] = []
  if (part.state.status === "completed" && !part.state.time.compacted && Array.isArray(metadata.loaded)) {
    for (const loaded of metadata.loaded) {
      if (typeof loaded === "string") lines.push({ text: `↳ Loaded ${ctx.formatPath(loaded)}` })
    }
  }

  return { name: "Read", arg: `${ctx.formatPath(filePath)}${extra ? ` ${extra}` : ""}`, lines }
}

function describeGlob(part: ToolPart, ctx: ToolWriterContext): ToolRecord {
  const input = stateInput(part)
  const count = numberValue(stateMetadata(part).count)
  const path = stringValue(input.path)
  const lines: GutterLine[] = []
  if (count !== undefined) {
    lines.push({ text: `${plural(count, "match")}${path ? ` in ${ctx.formatPath(path)}` : ""}` })
  }
  return { name: "Glob", arg: stringValue(input.pattern), lines }
}

function describeGrep(part: ToolPart, ctx: ToolWriterContext): ToolRecord {
  const input = stateInput(part)
  const matches = numberValue(stateMetadata(part).matches)
  const path = stringValue(input.path)
  const lines: GutterLine[] = []
  if (matches !== undefined) {
    lines.push({ text: `${plural(matches, "match")}${path ? ` in ${ctx.formatPath(path)}` : ""}` })
  }
  return { name: "Grep", arg: stringValue(input.pattern), lines }
}

function describeWebFetch(part: ToolPart): ToolRecord {
  return { name: "WebFetch", arg: stringValue(stateInput(part).url), lines: [] }
}

function describeWebSearch(part: ToolPart): ToolRecord {
  const metadata = stateMetadata(part)
  const results = numberValue(metadata.numResults)
  return {
    name: webSearchProviderLabel(metadata.provider),
    arg: stringValue(stateInput(part).query),
    lines: results !== undefined ? [{ text: plural(results, "result") }] : [],
  }
}

function describeTask(part: ToolPart, task?: TaskDetail): ToolRecord {
  const input = stateInput(part)
  const metadata = stateMetadata(part)
  const agent = Locale.titlecase(stringValue(input.subagent_type) ?? "General")
  const background = metadata.background === true

  const lines: GutterLine[] = [{ text: `${agent}${background ? " · background" : ""}` }]
  if (task && part.state.status === "completed") {
    lines.push({ text: formatCompletedSubagentDetail(task.toolcalls, Locale.duration(task.durationMs)) })
  }

  return { name: "Task", arg: stringValue(input.description), lines }
}

function describeExecute(part: ToolPart, ctx: ToolWriterContext, width: number): ToolRecord {
  const metadata = stateMetadata(part)
  const lines: GutterLine[] = executeCalls(metadata.toolCalls).map((call) => {
    const args = inlineArgs(call.input ?? {})
    return {
      text: `↳ ${call.tool}${args ? ` ${args}` : ""}${call.status === "error" ? " (failed)" : ""}`,
      fg: call.status === "error" ? ctx.theme.error : undefined,
    }
  })

  if (metadata.error === true) {
    const output = stripAnsi(stateOutput(part)?.trim() ?? "")
    if (output) {
      const preview = collapseToolOutput(output, 4, 4 * Math.max(20, width - 6)).output
      for (const line of preview.split("\n")) lines.push({ text: line, fg: ctx.theme.error })
    }
  }

  return { name: "Execute", lines }
}

function describeTodoWrite(part: ToolPart, ctx: ToolWriterContext): ToolRecord {
  const todos = parseTodos(stateInput(part).todos)
  return {
    name: "Todos",
    lines: todos.map((todo) => ({
      text: todoText(todo),
      fg: todo.status === "in_progress" ? ctx.theme.warning : ctx.theme.textMuted,
    })),
  }
}

function describeQuestion(part: ToolPart, ctx: ToolWriterContext): ToolRecord {
  const questions = parseQuestions(stateInput(part).questions)
  const answers = parseQuestionAnswers(stateMetadata(part).answers)

  const lines: GutterLine[] = []
  questions.forEach((question, index) => {
    lines.push({ text: question.question })
    const answer = answers?.[index]
    lines.push({ text: answer?.length ? answer.join(", ") : "(no answer)", fg: ctx.theme.text })
  })

  return { name: "Question", arg: plural(questions.length, "question"), lines }
}

function describeSkill(part: ToolPart): ToolRecord {
  return { name: "Skill", arg: stringValue(stateInput(part).name), lines: [] }
}

function describeGeneric(part: ToolPart): ToolRecord {
  return {
    name: Locale.titlecase(part.tool),
    arg: part.state.status === "completed" ? part.state.title : undefined,
    lines: [],
  }
}

function describe(part: ToolPart, ctx: ToolWriterContext, width: number, task?: TaskDetail): ToolRecord {
  const record = (() => {
    switch (part.tool) {
      case "bash":
        return describeBash(part, ctx, width)
      case "write":
        return describeWrite(part, ctx)
      case "edit":
        return describeEdit(part, ctx)
      case "apply_patch":
        return describeApplyPatch(part, ctx)
      case "read":
        return describeRead(part, ctx)
      case "glob":
        return describeGlob(part, ctx)
      case "grep":
        return describeGrep(part, ctx)
      case "webfetch":
        return describeWebFetch(part)
      case "websearch":
        return describeWebSearch(part)
      case "task":
        return describeTask(part, task)
      case "execute":
        return describeExecute(part, ctx, width)
      case "todowrite":
        return describeTodoWrite(part, ctx)
      case "question":
        return describeQuestion(part, ctx)
      case "skill":
        return describeSkill(part)
      default:
        return describeGeneric(part)
    }
  })()

  if (part.state.status === "error") {
    for (const line of part.state.error.trim().split("\n")) {
      record.lines.push({ text: line, fg: ctx.theme.error })
    }
  }

  return record
}

// ---------------------------------------------------------------------------
// Rendering.

function DiffView(props: { diff: string; file?: string; ctx: ToolWriterContext }) {
  const theme = props.ctx.theme
  return (
    <diff
      diff={props.diff}
      view="unified"
      filetype={filetype(props.file)}
      syntaxStyle={props.ctx.syntax}
      showLineNumbers={true}
      width="100%"
      wrapMode={props.ctx.diffWrapMode}
      fg={theme.text}
      addedBg={transparent}
      removedBg={transparent}
      contextBg={transparent}
      addedSignColor={theme.diffHighlightAdded}
      removedSignColor={theme.diffHighlightRemoved}
      lineNumberFg={theme.diffLineNumber}
      lineNumberBg={transparent}
      addedLineNumberBg={transparent}
      removedLineNumberBg={transparent}
    />
  )
}

function ToolRecordView(props: { record: ToolRecord; theme: Theme; failed: boolean }) {
  const theme = props.theme
  const record = props.record
  return (
    <box width="100%" flexDirection="column">
      <text width="100%" wrapMode="word">
        <span style={{ fg: props.failed ? theme.error : theme.success }}>⏺ </span>
        <span style={{ fg: theme.text, bold: true }}>{record.name}</span>
        {record.arg ? <span style={{ fg: theme.textMuted }}>({record.arg})</span> : null}
      </text>
      {record.lines.length > 0 || record.rich ? (
        <box width="100%" flexDirection="row">
          <text wrapMode="none" fg={theme.textMuted}>
            {"  ⎿  "}
          </text>
          <box flexGrow={1} flexShrink={1} flexDirection="column">
            {record.lines.map((line) => (
              <text width="100%" wrapMode="word" fg={line.fg ?? theme.textMuted}>
                {line.text}
              </text>
            ))}
            {record.rich?.()}
          </box>
        </box>
      ) : null}
    </box>
  )
}

export function toolWriter(input: { part: ToolPart; ctx: ToolWriterContext; task?: TaskDetail }): ScrollbackWriter {
  return createScrollbackWriter(
    (scrollback) => {
      const width = Math.max(20, Math.trunc(scrollback.width))
      const record = describe(input.part, input.ctx, width, input.task)
      return <ToolRecordView record={record} theme={input.ctx.theme} failed={input.part.state.status === "error"} />
    },
    { startOnNewLine: true, trailingNewline: false },
  )
}

// ---------------------------------------------------------------------------
// Collapsed read/grep/glob runs: one `⏺ Explored(…)` record with one gutter
// line per call.

function runLine(part: ToolPart, ctx: ToolWriterContext): GutterLine {
  const input = stateInput(part)
  const metadata = stateMetadata(part)
  const failed = part.state.status === "error"

  const base = (() => {
    if (part.tool === "read") return `Read ${ctx.formatPath(stringValue(input.filePath))}`
    const pattern = stringValue(input.pattern) ?? ""
    const count = numberValue(part.tool === "grep" ? metadata.matches : metadata.count)
    const suffix = count !== undefined ? ` (${plural(count, "match")})` : ""
    return `${Locale.titlecase(part.tool)} ${pattern}${suffix}`
  })()

  return { text: failed ? `${base} (failed)` : base, fg: failed ? ctx.theme.error : undefined }
}

function runSummary(parts: ToolPart[]): string {
  const counts = new Map<string, number>()
  for (const part of parts) counts.set(part.tool, (counts.get(part.tool) ?? 0) + 1)
  return [...counts.entries()].map(([tool, count]) => plural(count, tool)).join(" · ")
}

export function toolRunWriter(input: { parts: ToolPart[]; ctx: ToolWriterContext }): ScrollbackWriter {
  if (input.parts.length === 1) return toolWriter({ part: input.parts[0], ctx: input.ctx })
  return createScrollbackWriter(
    () => {
      const failed = input.parts.some((part) => part.state.status === "error")
      const record: ToolRecord = {
        name: "Explored",
        arg: runSummary(input.parts),
        lines: input.parts.map((part) => runLine(part, input.ctx)),
      }
      return <ToolRecordView record={record} theme={input.ctx.theme} failed={failed} />
    },
    { startOnNewLine: true, trailingNewline: false },
  )
}
