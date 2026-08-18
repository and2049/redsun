// REDSUN: mirrors Claude Code's own subagents into real v2 child sessions.
//
// Claude Code runs its subagents inside its own process, so without this they
// are invisible: translate.ts drops every frame carrying `parent_tool_use_id`
// (that is the main-thread contract) and the parent transcript shows one opaque
// `subagent` tool call. Mirroring gives each one a real child session, which the
// TUI already knows how to render — it discovers children from `session.created`
// with a matching parentID and drives their status from the execution events, so
// this needs no TUI work at all.
//
// Transcript authoring is durable-event publication, v2's replacement for V1's
// `Session.updateMessage`/`updatePart` no-LLM path: the projector turns
// step/text/reasoning/tool events into exactly the message rows an ordinary
// assistant turn would produce.
//
// Two rules here are load-bearing and were paid for in V1:
//
//   1. Mark, don't delete. The CLI emits `task_notification` for a *foreground*
//      task BEFORE the main-thread `tool_result` for the same call, and
//      translate.ts looks the child up at that tool_result to attach
//      `providerMetadata.redsun`. Deleting on notification loses the link. Only
//      the turn-end sweep clears entries.
//   2. `children()` returns the live map, never a copy. language-model.ts reads
//      it once per turn and hands the reference to `makeState` before any child
//      exists; a snapshot would always be empty.
//
// Accepted limit: the turn-end sweep closes and forgets every entry, so a
// *background* subagent that outlives the turn loses its tail here. The parent's
// tool result still reports it was backgrounded. This matches V1, which could
// not see between-turn frames at all; keeping such entries alive instead would
// leave a child permanently busy whenever the CLI dies or a turn is interrupted.
//
// Kept Effect-free like sessions.ts — the Agent SDK boundary is promises, and
// the Effect seam lives in provider.ts behind the `Ops` port.
export * as ClaudeCodeSubagents from "./subagents.js"

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeNativeTools } from "./native-tools.js"

/** A durable event to project into one child session's aggregate. */
export type ChildEvent =
  | { readonly kind: "execution-started"; readonly sessionID: string }
  | { readonly kind: "execution-succeeded"; readonly sessionID: string }
  | { readonly kind: "synthetic"; readonly sessionID: string; readonly text: string }
  | { readonly kind: "step-started"; readonly sessionID: string; readonly messageID: string; readonly agent: string }
  | { readonly kind: "step-ended"; readonly sessionID: string; readonly messageID: string }
  | {
      readonly kind: "text"
      readonly sessionID: string
      readonly messageID: string
      readonly ordinal: number
      readonly text: string
    }
  | {
      readonly kind: "reasoning"
      readonly sessionID: string
      readonly messageID: string
      readonly ordinal: number
      readonly text: string
    }
  | {
      readonly kind: "tool-called"
      readonly sessionID: string
      readonly messageID: string
      readonly id: string
      readonly name: string
      readonly input: Record<string, unknown>
    }
  | {
      readonly kind: "tool-result"
      readonly sessionID: string
      readonly messageID: string
      readonly id: string
      readonly text: string
      readonly failed: boolean
    }

/**
 * The Effect-side port. provider.ts supplies the real implementation; tests
 * supply a recording fake, so the whole state machine is exercised without a
 * database or a live CLI.
 */
export interface Ops {
  /** Create a child session under the mirrored parent. Undefined on failure. */
  readonly createChild: (input: { title: string; agent: string }) => Promise<string | undefined>
  /** Project events into child aggregates, in order. */
  readonly publish: (events: readonly ChildEvent[]) => Promise<void>
  /** Fresh assistant message id. */
  readonly messageID: () => string
}

interface Entry {
  readonly sessionID: string
  readonly parentSessionID: string
  readonly description: string
  readonly agent: string
  /** A terminal `task_notification` arrived; kept until the turn-end sweep. */
  settled: boolean
  /** The assistant message currently open in the child, if any. */
  open?: { readonly messageID: string; ordinal: number }
  /** SDK API message ids already mirrored, so repeats do not duplicate. */
  readonly seen: Set<string>
  /** tool_use id -> the child assistant message that issued it. */
  readonly tools: Map<string, string>
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const resultText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      const item = record(part)
      return item["type"] === "text" ? String(item["text"] ?? "") : ""
    })
    .filter(Boolean)
    .join("\n")
}

export interface Mirror {
  /** Feed one SDK frame. Awaited by the session pump, so calls are serialized. */
  observe(message: SDKMessage): Promise<void>
  /** The live map translate.ts reads, keyed by subagent tool_use id. */
  children(): ReadonlyMap<string, { sessionID: string; parentSessionID: string; description: string }>
  /** Close anything still open and clear the map. Runs at turn end. */
  sweep(): Promise<void>
}

export const make = (input: { readonly parentSessionID: string; readonly ops: Ops }): Mirror => {
  const { parentSessionID, ops } = input
  const entries = new Map<string, Entry>()
  /** task_id -> tool_use_id, because notifications may carry only the task id. */
  const byTask = new Map<string, string>()

  const closeOpen = (entry: Entry, events: ChildEvent[]) => {
    if (!entry.open) return
    events.push({ kind: "step-ended", sessionID: entry.sessionID, messageID: entry.open.messageID })
    entry.open = undefined
  }

  const started = async (message: Record<string, unknown>) => {
    // Ambient housekeeping tasks are explicitly not for the transcript.
    if (message["skip_transcript"] === true) return
    const toolUseID = message["tool_use_id"]
    // Without a tool_use id there is nothing for translate.ts to correlate the
    // child against, so the parent's tool call could never link to it.
    if (typeof toolUseID !== "string" || !toolUseID) return
    if (entries.has(toolUseID)) return

    const description = typeof message["description"] === "string" ? message["description"] : "subagent"
    const agent = typeof message["subagent_type"] === "string" && message["subagent_type"] ? message["subagent_type"] : "general"
    const sessionID = await ops.createChild({ title: `${description} (@${agent} subagent)`, agent })
    // A failed child creation degrades to V1's behaviour (an opaque tool call)
    // rather than failing the parent's turn.
    if (!sessionID) return

    const entry: Entry = {
      sessionID,
      parentSessionID,
      description,
      agent,
      settled: false,
      seen: new Set(),
      tools: new Map(),
    }
    entries.set(toolUseID, entry)
    const taskID = message["task_id"]
    if (typeof taskID === "string" && taskID) byTask.set(taskID, toolUseID)

    const events: ChildEvent[] = [{ kind: "execution-started", sessionID }]
    const prompt = message["prompt"]
    if (typeof prompt === "string" && prompt) events.push({ kind: "synthetic", sessionID, text: prompt })
    await ops.publish(events)
  }

  const notified = async (message: Record<string, unknown>) => {
    const toolUseID =
      typeof message["tool_use_id"] === "string"
        ? message["tool_use_id"]
        : typeof message["task_id"] === "string"
          ? byTask.get(message["task_id"] as string)
          : undefined
    const entry = toolUseID ? entries.get(toolUseID) : undefined
    if (!entry || entry.settled) return
    // Mark, never delete — see the header. The parent's tool_result is still
    // to come for a foreground task, and it needs this entry.
    entry.settled = true
    const events: ChildEvent[] = []
    closeOpen(entry, events)
    events.push({ kind: "execution-succeeded", sessionID: entry.sessionID })
    await ops.publish(events)
  }

  const assistant = async (entry: Entry, message: Record<string, unknown>) => {
    const inner = record(message["message"])
    const apiID = typeof inner["id"] === "string" ? inner["id"] : undefined
    if (apiID && entry.seen.has(apiID)) return
    if (apiID) entry.seen.add(apiID)
    const content = inner["content"]
    if (!Array.isArray(content) || content.length === 0) return

    const events: ChildEvent[] = []
    closeOpen(entry, events)
    const messageID = ops.messageID()
    entry.open = { messageID, ordinal: 0 }
    events.push({ kind: "step-started", sessionID: entry.sessionID, messageID, agent: entry.agent })

    for (const block of content) {
      const item = record(block)
      const type = item["type"]
      if (type === "text") {
        const text = String(item["text"] ?? "")
        if (!text) continue
        events.push({
          kind: "text",
          sessionID: entry.sessionID,
          messageID,
          ordinal: entry.open.ordinal++,
          text,
        })
        continue
      }
      if (type === "thinking" || type === "redacted_thinking") {
        const text = String(item["thinking"] ?? "")
        if (!text) continue
        events.push({
          kind: "reasoning",
          sessionID: entry.sessionID,
          messageID,
          ordinal: entry.open.ordinal++,
          text,
        })
        continue
      }
      if (type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use") {
        const id = item["id"]
        const name = item["name"]
        if (typeof id !== "string" || typeof name !== "string") continue
        entry.tools.set(id, messageID)
        events.push({
          kind: "tool-called",
          sessionID: entry.sessionID,
          messageID,
          id,
          name: ClaudeCodeNativeTools.toolName(name),
          input: ClaudeCodeNativeTools.toolInput(name, record(item["input"])),
        })
      }
    }
    await ops.publish(events)
  }

  const user = async (entry: Entry, message: Record<string, unknown>) => {
    const content = record(message["message"])["content"]
    if (!Array.isArray(content)) return
    const events: ChildEvent[] = []
    for (const block of content) {
      const item = record(block)
      if (item["type"] !== "tool_result") continue
      const id = item["tool_use_id"]
      if (typeof id !== "string") continue
      const messageID = entry.tools.get(id)
      if (!messageID) continue
      events.push({
        kind: "tool-result",
        sessionID: entry.sessionID,
        messageID,
        id,
        text: resultText(item["content"]),
        failed: item["is_error"] === true,
      })
    }
    if (events.length) await ops.publish(events)
  }

  return {
    observe: async (message) => {
      const raw = message as unknown as Record<string, unknown>
      if (raw["type"] === "system") {
        if (raw["subtype"] === "task_started") return started(raw)
        if (raw["subtype"] === "task_notification") return notified(raw)
        return
      }
      const parent = raw["parent_tool_use_id"]
      if (typeof parent !== "string" || !parent) return
      const entry = entries.get(parent)
      // Nested subagents (a subagent spawning its own) are not mirrored: their
      // task_started carries no parent linkage, so they would land as siblings
      // rather than grandchildren. They stay inside the child's tool output.
      if (!entry) return
      // stream_event deltas are deliberately ignored — the full assistant and
      // user frames (forwardSubagentText) carry authoritative content, and
      // reconstructing partial blocks buys no fidelity the child view shows.
      if (raw["type"] === "assistant") return assistant(entry, raw)
      if (raw["type"] === "user") return user(entry, raw)
    },
    children: () => entries,
    sweep: async () => {
      const events: ChildEvent[] = []
      for (const entry of entries.values()) {
        if (entry.settled) continue
        // An interrupted or still-running task settles here so the child never
        // shows as permanently busy.
        closeOpen(entry, events)
        events.push({ kind: "execution-succeeded", sessionID: entry.sessionID })
      }
      entries.clear()
      byTask.clear()
      if (events.length) await ops.publish(events)
    },
  }
}
