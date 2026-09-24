export * as ClaudeCodeSubagents from "./subagents.js"

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeNativeTools } from "./native-tools.js"

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

export interface Ops {
  readonly createChild: (input: { title: string; agent: string }) => Promise<string | undefined>
  readonly publish: (events: readonly ChildEvent[]) => Promise<void>
  readonly messageID: () => string
}

interface Entry {
  readonly sessionID: string
  readonly parentSessionID: string
  readonly description: string
  readonly agent: string
  settled: boolean
  resolution?: "async" | "done"
  open?: { readonly messageID: string; ordinal: number }
  readonly seen: Set<string>
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

/**
 * What the native session still owes the host turn once a result frame lands.
 * - active: a main-thread turn is streaming (frames since the last result).
 * - children: idle, but a background subagent has not settled; its
 *   task_notification will queue a continuation turn.
 * - queued: idle, nothing running, but a task notification arrived that no
 *   turn has consumed yet; the CLI starts that turn on its own, promptly.
 * - none: idle with nothing pending.
 */
export type Continuation = "active" | "children" | "queued" | "none"

export interface Mirror {
  observe(message: SDKMessage, inTurn?: boolean): Promise<void>
  children(): ReadonlyMap<string, { sessionID: string; parentSessionID: string; description: string }>
  continuation(): Continuation
  sweep(): Promise<void>
  finalize(): Promise<void>
}

export const make = (input: { readonly parentSessionID: string; readonly ops: Ops }): Mirror => {
  const { parentSessionID, ops } = input
  const entries = new Map<string, Entry>()
  const byTask = new Map<string, string>()
  // Main-thread phase: frames since the last result mean a turn is streaming.
  let active = false
  // A non-ambient task settled and the CLI has yet to start the turn that
  // reads its notification. Cleared when the next main-thread turn begins.
  let notified = false

  const closeOpen = (entry: Entry, events: ChildEvent[]) => {
    if (!entry.open) return
    events.push({ kind: "step-ended", sessionID: entry.sessionID, messageID: entry.open.messageID })
    entry.open = undefined
  }

  // Only spawned subagents get a child session. Background Bash, MCP tasks,
  // workflows and monitors also arrive as task_started with a tool_use_id, but
  // no frame ever carries their id as parent_tool_use_id: mirroring them mints
  // an empty session titled after a shell command.
  const isSubagentTask = (message: Record<string, unknown>) => {
    const type = message["task_type"]
    if (type === "local_agent") return true
    return type === undefined && typeof message["subagent_type"] === "string"
  }

  const started = async (message: Record<string, unknown>) => {
    if (message["skip_transcript"] === true) return
    if (!isSubagentTask(message)) return
    const toolUseID = message["tool_use_id"]
    if (typeof toolUseID !== "string" || !toolUseID) return
    if (entries.has(toolUseID)) return

    const description = typeof message["description"] === "string" ? message["description"] : "subagent"
    const agent =
      typeof message["subagent_type"] === "string" && message["subagent_type"] ? message["subagent_type"] : "general"
    const sessionID = await ops.createChild({ title: `${description} (@${agent} subagent)`, agent })
    if (!sessionID) return

    const entry: Entry = {
      sessionID,
      parentSessionID,
      description,
      agent,
      settled: false,
      // The CLI says up front whether the spawning tool call blocks on the
      // agent; the launching tool_result repeats it as status async_launched.
      ...(message["is_backgrounded"] === true ? { resolution: "async" as const } : {}),
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

  const notification = async (message: Record<string, unknown>) => {
    if (message["ambient"] !== true && message["skip_transcript"] !== true) notified = true
    const toolUseID =
      typeof message["tool_use_id"] === "string"
        ? message["tool_use_id"]
        : typeof message["task_id"] === "string"
          ? byTask.get(message["task_id"] as string)
          : undefined
    const entry = toolUseID ? entries.get(toolUseID) : undefined
    if (!entry || entry.settled) return
    entry.settled = true
    const events: ChildEvent[] = []
    closeOpen(entry, events)
    events.push({ kind: "execution-succeeded", sessionID: entry.sessionID })
    await ops.publish(events)
  }

  // A foreground agent moved to the background (Ctrl+B or the control
  // request) keeps running past the parent's result like an async launch.
  const updated = (message: Record<string, unknown>) => {
    const patch = record(message["patch"])
    if (patch["is_backgrounded"] !== true) return
    const taskID = message["task_id"]
    const toolUseID = typeof taskID === "string" ? byTask.get(taskID) : undefined
    const entry = toolUseID ? entries.get(toolUseID) : undefined
    if (entry && !entry.settled) entry.resolution = "async"
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

  // The launching Task's main-thread tool_result says whether the CLI ran the
  // subagent to completion ("done") or async-launched it, in which case its
  // frames and task_notification arrive after the parent turn's result.
  const resolved = (message: Record<string, unknown>) => {
    const content = record(message["message"])["content"]
    if (!Array.isArray(content)) return
    const status = record(message["tool_use_result"])["status"]
    for (const block of content) {
      const item = record(block)
      if (item["type"] !== "tool_result") continue
      const id = item["tool_use_id"]
      if (typeof id !== "string") continue
      const entry = entries.get(id)
      if (entry) entry.resolution = status === "async_launched" ? "async" : "done"
    }
  }

  const settle = async (predicate: (entry: Entry) => boolean) => {
    const events: ChildEvent[] = []
    for (const entry of entries.values()) {
      if (entry.settled || !predicate(entry)) continue
      entry.settled = true
      closeOpen(entry, events)
      events.push({ kind: "execution-succeeded", sessionID: entry.sessionID })
    }
    if (events.length) await ops.publish(events)
  }

  const beginTurn = () => {
    if (active) return
    active = true
    notified = false
  }

  return {
    observe: async (message) => {
      const raw = message as unknown as Record<string, unknown>
      if (raw["type"] === "result") {
        active = false
        return
      }
      if (raw["type"] === "system") {
        if (raw["subtype"] === "task_started") return started(raw)
        if (raw["subtype"] === "task_notification") return notification(raw)
        if (raw["subtype"] === "task_updated") return updated(raw)
        // The CLI re-announces init at the start of every turn it opens on
        // its own (task notifications, auto-continuation).
        if (raw["subtype"] === "init") beginTurn()
        return
      }
      const parent = raw["parent_tool_use_id"]
      if (typeof parent !== "string" || !parent) {
        if (raw["type"] === "assistant" || raw["type"] === "stream_event" || raw["type"] === "user") beginTurn()
        if (raw["type"] === "user") resolved(raw)
        return
      }
      const entry = entries.get(parent)
      if (!entry) return
      if (raw["type"] === "assistant") return assistant(entry, raw)
      if (raw["type"] === "user") return user(entry, raw)
    },
    children: () => entries,
    continuation: () => {
      if (active) return "active"
      for (const entry of entries.values()) if (entry.resolution === "async" && !entry.settled) return "children"
      return notified ? "queued" : "none"
    },
    // Turn end: async-launched children are still running and keep their
    // entries; everything else is settled but never deleted — late lookups and
    // the live children() map depend on the entries surviving.
    sweep: () => settle((entry) => entry.resolution !== "async"),
    // Process exit: nothing can settle or reference these children any more.
    finalize: async () => {
      await settle(() => true)
      entries.clear()
      byTask.clear()
    },
  }
}
