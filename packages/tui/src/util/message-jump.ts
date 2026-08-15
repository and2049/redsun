// Pure helpers for vim-style J/K conversation jumps in the session transcript.
// Target predicates must mirror the render predicates in routes/session/index.tsx:
// UserMessage renders when a text part has !synthetic && text.trim(); assistant
// TextPart renders on text.trim() alone; summary === true assistant messages
// render as CompactionSummary and are not conversation turns.

// summary is unknown because the SDK types it differently per role: boolean on
// AssistantMessage (compaction summary), snapshot object on UserMessage. Only
// the assistant branch reads it, as a truthiness check.
export type JumpMessage = { id: string; role: "user" | "assistant"; summary?: unknown }
export type JumpPart = { id: string; type: string; synthetic?: boolean; text?: string }

/** Renderable ids of conversation turns, in transcript order.
 *  user turn -> message.id (its box carries that id); assistant (non-summary)
 *  turn -> its first rendered text part's id. Tool-only, reasoning-only, and
 *  empty/streaming messages yield no target. */
export function conversationTargetIds(
  messages: JumpMessage[],
  partsFor: (messageID: string) => JumpPart[] | undefined,
): string[] {
  const out: string[] = []
  for (const message of messages) {
    const parts = partsFor(message.id)
    if (!parts) continue
    if (message.role === "user") {
      if (parts.some((part) => part.type === "text" && !part.synthetic && part.text?.trim())) out.push(message.id)
      continue
    }
    if (message.summary) continue
    const text = parts.find((part) => part.type === "text" && part.text?.trim())
    if (text) out.push(text.id)
  }
  return out
}

/** offsets: content-space y of each target, sorted ascending. Returns the
 *  destination content offset, or undefined when there is no target in that
 *  direction (caller falls back to the transcript edge). Jumps land targets at
 *  scrollTop + 1, so the anchor treats that row as the current turn and
 *  repeated presses advance exactly one turn. */
export function resolveJump(
  offsets: number[],
  scrollTop: number,
  direction: "down" | "up",
  count: number,
): number | undefined {
  if (offsets.length === 0) return undefined
  const steps = Math.max(1, count)
  const anchor = scrollTop + 1
  if (direction === "down") {
    const index = offsets.findIndex((offset) => offset > anchor)
    if (index === -1) return undefined
    return offsets[Math.min(index + steps - 1, offsets.length - 1)]
  }
  const index = offsets.findLastIndex((offset) => offset < anchor)
  if (index === -1) return undefined
  return offsets[Math.max(index - steps + 1, 0)]
}
