// Orders and commits transcript blocks into native terminal scrollback.
//
// The committer walks the derived block list (see blocks.ts) with a strictly
// ordered cursor: a block is only written once every earlier block is final
// and committed. The earliest non-final assistant-text block streams through
// a retained StreamSurface with progressive commits; everything else commits
// as a one-shot static writer. Committed output is immutable — a prefix-key
// mismatch (e.g. session revert, handled by replay in a later phase) freezes
// the committer instead of corrupting scrollback.
import type { CliRenderer, SyntaxStyle, TreeSitterClient } from "@opentui/core"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { GoalVerdict } from "../../context/session-goal"
import type { Theme } from "../../theme"
import * as Locale from "../../util/locale"
import { StreamSurface } from "../scrollback/stream-surface"
import { errorWriter, noteWriter, spacerWriter, turnSummaryWriter, userWriter } from "../scrollback/writers"
import { deriveBlocks, type TaskDetail, type TranscriptBlock } from "./blocks"
import { toolRunWriter, toolWriter, type ToolWriterContext } from "./tools"

export type CommitterInput = {
  renderer: CliRenderer
  sessionID: string
  // The reactive sync store slices (sync.data). Reads happen inside drain —
  // reactive scheduling is the caller's job via notify().
  data: {
    message: { [sessionID: string]: Message[] }
    part: { [messageID: string]: Part[] }
  }
  theme: () => Theme
  syntax: () => SyntaxStyle
  treeSitterClient?: TreeSitterClient
  // Path presentation for tool records; identity when omitted (tests).
  formatPath?: (input?: string) => string
  normalizePath?: (input: string) => string
  diffWrapMode?: () => "word" | "none"
  // Goal verdict lookup for turn summaries (sync.data.session_goal).
  goalVerdict?: (messageID: string) => GoalVerdict | undefined
  // True when something (e.g. the session banner) was already written to
  // scrollback, so the first block gets a leading blank row.
  wrote?: boolean
}

export type TranscriptCommitter = {
  // Schedule a drain. Safe to call from reactive effects; drains are
  // single-flight and re-run while notifications arrive mid-drain.
  notify(): void
  // Resolves when no drain is running or queued.
  idle(): Promise<void>
  // True when the derived list no longer matches committed output (revert).
  readonly desynced: boolean
  dispose(): void
}

export function createTranscriptCommitter(input: CommitterInput): TranscriptCommitter {
  const processed: string[] = []
  let active: { key: string; surface: StreamSurface } | undefined
  let wrote = input.wrote ?? false
  let draining = false
  let queued = false
  let disposed = false
  let desynced = false
  const idleResolvers: (() => void)[] = []

  // Snapshot of a task tool's child session, read from the same store.
  function taskDetail(sessionID: string): TaskDetail | undefined {
    const messages = input.data.message[sessionID]
    if (!messages?.length) return undefined
    const toolcalls = messages.reduce(
      (count, message) => count + (input.data.part[message.id] ?? []).filter((part) => part.type === "tool").length,
      0,
    )
    const first = messages.find((message) => message.role === "user")?.time.created
    const last = messages.findLast((message) => message.role === "assistant")?.time.completed
    return { toolcalls, durationMs: first && last ? Math.max(0, last - first) : 0 }
  }

  const blocks = () =>
    deriveBlocks({
      messages: input.data.message[input.sessionID] ?? [],
      partsOf: (messageID) => input.data.part[messageID] ?? [],
      taskDetail,
      goalVerdict: input.goalVerdict,
    })

  function writerContext(): ToolWriterContext {
    return {
      theme: input.theme(),
      syntax: input.syntax(),
      formatPath: input.formatPath ?? ((path) => path ?? ""),
      normalizePath: input.normalizePath ?? ((path) => path),
      diffWrapMode: input.diffWrapMode?.() ?? "word",
    }
  }

  function resolveIdle(): void {
    for (const resolve of idleResolvers.splice(0)) resolve()
  }

  function spacer(): void {
    if (!wrote) return
    input.renderer.writeToScrollback(spacerWriter())
  }

  function writeStatic(block: TranscriptBlock): void {
    const theme = input.theme()
    spacer()
    switch (block.kind) {
      case "user":
        input.renderer.writeToScrollback(userWriter({ text: block.text, theme }))
        break
      case "note":
        input.renderer.writeToScrollback(noteWriter({ text: block.text, theme }))
        break
      case "reasoning":
        input.renderer.writeToScrollback(
          noteWriter({
            symbol: "✳",
            text: block.durationMs !== undefined ? `Thought for ${Locale.duration(block.durationMs)}` : "Thought",
            theme,
          }),
        )
        break
      case "tool":
        input.renderer.writeToScrollback(toolWriter({ part: block.part, ctx: writerContext(), task: block.task }))
        break
      case "tool-run":
        input.renderer.writeToScrollback(toolRunWriter({ parts: block.parts, ctx: writerContext() }))
        break
      case "error":
        input.renderer.writeToScrollback(errorWriter({ text: block.text, theme }))
        break
      case "turn-summary":
        input.renderer.writeToScrollback(
          turnSummaryWriter({
            agent: Locale.titlecase(block.agent),
            model: block.model,
            duration: Locale.duration(block.durationMs),
            theme,
            verdict: block.verdict,
          }),
        )
        break
      case "assistant-text":
        // Streamed, never static.
        break
    }
    wrote = true
  }

  function dropActive(): void {
    if (!active) return
    active.surface.destroy()
    active = undefined
  }

  function ensureActive(key: string): StreamSurface {
    if (active && active.key !== key) dropActive()
    if (!active) {
      const theme = input.theme()
      active = {
        key,
        surface: new StreamSurface(
          input.renderer,
          { type: "markdown", fg: theme.markdownText, syntaxStyle: input.syntax() },
          { leadingSpacerRows: wrote ? 1 : 0, treeSitterClient: input.treeSitterClient },
        ),
      }
    }
    return active.surface
  }

  async function step(): Promise<void> {
    if (disposed || desynced) return
    const list = blocks()

    for (let index = 0; index < processed.length; index++) {
      if (list[index]?.key !== processed[index]) {
        desynced = true
        return
      }
    }

    let index = processed.length
    while (!disposed && index < list.length) {
      const block = list[index]

      if (block.kind === "assistant-text") {
        if (block.skip) {
          if (active?.key === block.key) dropActive()
          processed.push(block.key)
          index++
          continue
        }

        const surface = ensureActive(block.key)
        surface.setContent(block.content)

        if (!block.final) {
          await surface.stream()
          if (surface.wrote) wrote = true
          return
        }

        await surface.finish(false)
        if (surface.wrote) wrote = true
        active = undefined
        processed.push(block.key)
        index++
        continue
      }

      if (!block.final) return

      if (!block.skip) {
        writeStatic(block)
      }
      processed.push(block.key)
      index++
    }
  }

  async function drain(): Promise<void> {
    if (draining) {
      queued = true
      return
    }

    draining = true
    try {
      do {
        queued = false
        await step()
      } while (queued && !disposed)
    } finally {
      draining = false
      if (!disposed) input.renderer.requestRender()
      resolveIdle()
    }
  }

  return {
    notify() {
      void drain()
    },
    idle() {
      if (!draining && !queued) return Promise.resolve()
      return new Promise((resolve) => idleResolvers.push(resolve))
    },
    get desynced() {
      return desynced
    },
    dispose() {
      if (disposed) return
      disposed = true
      dropActive()
      resolveIdle()
    },
  }
}
