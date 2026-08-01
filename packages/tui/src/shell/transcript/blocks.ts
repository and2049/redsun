// Pure derivation of the ordered transcript block list from sync-store data.
//
// Blocks commit into native scrollback strictly in list order, so the derived
// list must be prefix-stable: for any committed prefix, later derivations
// yield the same keys in the same order. That holds because messages and parts
// are id-ordered and append-only, per-message trailer blocks (error/summary)
// only appear once the message completes, and queued user messages (id newer
// than the in-flight assistant message) are excluded until promotion — the
// dock renders those as mutable queued rows instead.
//
// A block with `final: false` blocks the queue until its data settles. A block
// with `skip: true` is final but renders nothing (advance without writing).
//
// Consecutive read/grep/glob tool parts merge into a single `tool-run` block
// keyed by the first part's id. The key never changes while the run grows (the
// run only closes when a non-collapsible part follows or the message
// completes), so prefix stability is preserved.
import type { AssistantMessage, Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import type { GoalVerdict } from "../../context/session-goal"

// Summary of a subagent (task tool) child session, derived from the sync
// store at derivation time.
export type TaskDetail = {
  toolcalls: number
  durationMs: number
}

export type TranscriptBlock =
  | { key: string; kind: "user"; final: boolean; skip?: boolean; text: string }
  | { key: string; kind: "assistant-text"; final: boolean; skip?: boolean; content: string }
  | { key: string; kind: "reasoning"; final: boolean; skip?: boolean; durationMs?: number }
  | { key: string; kind: "tool"; final: boolean; skip?: boolean; part: ToolPart; task?: TaskDetail }
  | { key: string; kind: "tool-run"; final: boolean; skip?: boolean; parts: ToolPart[] }
  | { key: string; kind: "note"; final: boolean; skip?: boolean; text: string }
  | { key: string; kind: "error"; final: boolean; skip?: boolean; text: string }
  | {
      key: string
      kind: "turn-summary"
      final: boolean
      skip?: boolean
      agent: string
      model: string
      durationMs: number
      // The goal verdict for this message, when it has already arrived by the
      // time the summary block is written. A verdict landing later is only
      // shown in the dock (committed scrollback is immutable) — never derived
      // as its own block, which could insert mid-list and break prefix
      // stability.
      verdict?: GoalVerdict
    }

export type TranscriptSource = {
  messages: readonly Message[]
  partsOf: (messageID: string) => readonly Part[]
  taskDetail?: (sessionID: string) => TaskDetail | undefined
  goalVerdict?: (messageID: string) => GoalVerdict | undefined
}

// Tools whose consecutive calls merge into one dense block.
const COLLAPSIBLE_TOOLS = new Set(["read", "grep", "glob"])

function errorText(error: NonNullable<AssistantMessage["error"]>): string {
  const data = error.data as { message?: unknown } | undefined
  if (data && typeof data.message === "string" && data.message.trim()) return data.message
  return error.name
}

function toolSettled(part: ToolPart): boolean {
  return part.state.status === "completed" || part.state.status === "error"
}

function taskSessionID(part: ToolPart): string | undefined {
  if (part.state.status === "pending") return undefined
  const metadata = part.state.metadata
  if (!metadata || typeof metadata !== "object") return undefined
  const value = (metadata as Record<string, unknown>).sessionId
  return typeof value === "string" ? value : undefined
}

// The in-flight assistant message, if any — user messages newer than it are
// queued, not yet promoted. Mirrors the classic session view's `pending` memo.
export function pendingAssistantID(messages: readonly Message[]): string | undefined {
  const completed = messages.findLast((x) => x.role === "assistant" && x.time.completed)?.id
  return messages.findLast((x) => x.role === "assistant" && !x.time.completed && (!completed || x.id > completed))?.id
}

export function deriveBlocks(source: TranscriptSource): TranscriptBlock[] {
  const out: TranscriptBlock[] = []
  const messages = source.messages
  const pending = pendingAssistantID(messages)

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const hasLaterMessage = index < messages.length - 1

    if (message.role === "user") {
      if (pending && message.id > pending) continue

      const parts = source.partsOf(message.id)
      const text = parts
        .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
        .join("\n\n")
        .trim()
      const final = text.length > 0 || hasLaterMessage
      out.push({ key: `${message.id}:user`, kind: "user", final, skip: final && !text, text })
      if (parts.some((part) => part.type === "compaction")) {
        out.push({ key: `${message.id}:compaction`, kind: "note", final: true, text: "≋ context compacted" })
      }
      continue
    }

    const completed = message.time.completed !== undefined
    const parts = source.partsOf(message.id)

    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex]
      const settled = completed || partIndex < parts.length - 1

      switch (part.type) {
        case "text": {
          if (part.ignored) break
          const final = settled || part.time?.end !== undefined
          out.push({
            key: `${part.id}:text`,
            kind: "assistant-text",
            final,
            skip: final && !part.text.trim(),
            content: part.text,
          })
          break
        }
        case "reasoning": {
          const final = settled || part.time.end !== undefined
          const content = part.text.replace("[REDACTED]", "").trim()
          const durationMs = part.time.end !== undefined ? Math.max(0, part.time.end - part.time.start) : undefined
          out.push({ key: `${part.id}:reasoning`, kind: "reasoning", final, skip: final && !content, durationMs })
          break
        }
        case "tool": {
          if (COLLAPSIBLE_TOOLS.has(part.tool)) {
            // Consume the maximal run of consecutive collapsible tool parts.
            let endIndex = partIndex
            while (endIndex < parts.length) {
              const candidate = parts[endIndex]
              if (candidate.type !== "tool" || !COLLAPSIBLE_TOOLS.has(candidate.tool)) break
              endIndex++
            }
            const runParts = parts.slice(partIndex, endIndex) as ToolPart[]
            // The run stays open (non-final) until something follows it — a
            // later part in this message or message completion — so committed
            // runs can never grow.
            const closed = completed || endIndex < parts.length
            out.push({
              key: `${part.id}:run`,
              kind: "tool-run",
              final: closed && runParts.every(toolSettled),
              parts: runParts,
            })
            partIndex = endIndex - 1
            break
          }

          const final = toolSettled(part)
          const sessionID = part.tool === "task" && final ? taskSessionID(part) : undefined
          out.push({
            key: `${part.id}:tool`,
            kind: "tool",
            final,
            part,
            task: sessionID ? source.taskDetail?.(sessionID) : undefined,
          })
          break
        }
        default:
          // step-start/step-finish/snapshot/patch/file/agent/retry/subtask
          // produce no scrollback blocks.
          break
      }
    }

    if (completed) {
      if (message.error) {
        const aborted = message.error.name === "MessageAbortedError"
        out.push(
          aborted
            ? { key: `${message.id}:interrupted`, kind: "note", final: true, text: "⨯ interrupted" }
            : { key: `${message.id}:error`, kind: "error", final: true, text: errorText(message.error) },
        )
      } else {
        out.push({
          key: `${message.id}:summary`,
          kind: "turn-summary",
          final: true,
          agent: message.mode,
          model: `${message.providerID}/${message.modelID}`,
          durationMs: Math.max(0, (message.time.completed ?? message.time.created) - message.time.created),
          verdict: source.goalVerdict?.(message.id),
        })
      }
    }
  }

  return out
}
