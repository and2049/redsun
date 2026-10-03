export * as AcpTranslate from "./translate.js"

import type { SessionUpdate, StopReason, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk"
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider"
import { AcpHostTools } from "./host-tools.js"

// ACP `session/update` notifications become AI SDK V3 stream parts. The agent runs its own tools,
// so every tool call is `providerExecuted` and settles with a tool-result from the agent itself.

export interface State {
  open?: { readonly kind: "text" | "reasoning"; readonly id: string }
  blocks: number
  readonly tools: Map<string, { readonly name: string; settled: boolean }>
  usage?: { readonly used: number; readonly size: number }
  /**
   * Context use the agent states only as a percentage of its window. It finishes as provider
   * metadata under `provider`, which the host keeps as the message's `providerState.contextPercent`.
   */
  contextPercent?: number
  /** The live usage last taken by `takeUsage`, serialized, so an unchanged value is not resent. */
  reportedUsage?: string
  readonly provider?: string
  /** The session's host tools: their calls render as the host's own tool rows. */
  readonly host?: AcpHostTools.Slot
}

export const make = (host?: AcpHostTools.Slot, provider?: string): State => ({
  blocks: 0,
  tools: new Map(),
  ...(host ? { host } : {}),
  ...(provider ? { provider } : {}),
})

const close = (state: State): LanguageModelV3StreamPart[] => {
  const open = state.open
  if (!open) return []
  state.open = undefined
  return [open.kind === "text" ? { type: "text-end", id: open.id } : { type: "reasoning-end", id: open.id }]
}

const openBlock = (state: State, kind: "text" | "reasoning"): LanguageModelV3StreamPart[] => {
  if (state.open?.kind === kind) return []
  const parts = close(state)
  const id = `acp-${kind}-${state.blocks++}`
  state.open = { kind, id }
  parts.push(kind === "text" ? { type: "text-start", id } : { type: "reasoning-start", id })
  return parts
}

/** A tool name the host's renderers recognise where the ACP kind maps onto one. */
export const toolName = (kind: ToolKind | null | undefined, title: string) => {
  switch (kind) {
    case "read":
      return "read"
    case "edit":
    case "delete":
    case "move":
      return "edit"
    case "search":
      return "grep"
    case "execute":
      return "shell"
    case "fetch":
      return "webfetch"
    default:
      return title || "tool"
  }
}

const contentText = (content: ReadonlyArray<ToolCallContent> | null | undefined) =>
  (content ?? [])
    .flatMap((item) => {
      if (item.type === "content") return item.content.type === "text" ? [item.content.text] : []
      if (item.type === "diff") return [`${item.path}\n${item.newText}`]
      if (item.type === "terminal") return [`[terminal ${item.terminalId}]`]
      return []
    })
    .join("\n")

const settle = (
  state: State,
  id: string,
  status: string | null | undefined,
  content: ReadonlyArray<ToolCallContent> | null | undefined,
  rawOutput: unknown,
): LanguageModelV3StreamPart[] => {
  const call = state.tools.get(id)
  if (!call || call.settled || (status !== "completed" && status !== "failed")) return []
  call.settled = true
  // The host's own result, recorded when it executed the call: its metadata renders the tool row.
  const hosted = state.host?.take(id)
  if (hosted && status === "completed") {
    const output = AcpHostTools.resultText(hosted)
    return [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: call.name,
        result: hosted.metadata === undefined ? output : { output, metadata: hosted.metadata },
      } as LanguageModelV3StreamPart,
    ]
  }
  const text = contentText(content) || (rawOutput === undefined ? "" : JSON.stringify(rawOutput))
  return [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: call.name,
      result: text || (status === "failed" ? "The tool failed." : "(no output)"),
      ...(status === "failed" ? { isError: true } : {}),
    } as LanguageModelV3StreamPart,
  ]
}

/** A host tool call the agent never reported: rendered from the host's side alone. */
export const hostCall = (state: State, id: string, name: string, args: unknown): LanguageModelV3StreamPart[] => {
  if (state.tools.has(id)) return []
  const parts = close(state)
  state.tools.set(id, { name, settled: false })
  parts.push({
    type: "tool-call",
    toolCallId: id,
    toolName: name,
    input: JSON.stringify(AcpHostTools.cleanInput(args) ?? {}),
    providerExecuted: true,
  })
  return parts
}

/** The host's result for such a call; the slot holds it, so only the status is needed. */
export const hostResult = (state: State, id: string, error?: unknown): LanguageModelV3StreamPart[] =>
  error === undefined
    ? settle(state, id, "completed", undefined, undefined)
    : settle(state, id, "failed", undefined, error instanceof Error ? error.message : String(error))

export const update = (state: State, update: SessionUpdate): LanguageModelV3StreamPart[] => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text" || !update.content.text) return []
      const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning"
      const parts = openBlock(state, kind)
      parts.push(
        kind === "text"
          ? { type: "text-delta", id: state.open!.id, delta: update.content.text }
          : { type: "reasoning-delta", id: state.open!.id, delta: update.content.text },
      )
      return parts
    }
    case "tool_call": {
      if (state.tools.has(update.toolCallId)) return []
      const parts = close(state)
      const hosted = state.host?.report(update)
      const name = hosted ?? toolName(update.kind, update.title)
      state.tools.set(update.toolCallId, { name, settled: false })
      parts.push({
        type: "tool-call",
        toolCallId: update.toolCallId,
        toolName: name,
        input: JSON.stringify(
          hosted ? AcpHostTools.cleanInput(update.rawInput ?? {}) : (update.rawInput ?? { title: update.title }),
        ),
        providerExecuted: true,
      })
      parts.push(...settle(state, update.toolCallId, update.status, update.content, update.rawOutput))
      return parts
    }
    case "tool_call_update":
      return settle(state, update.toolCallId, update.status, update.content, update.rawOutput)
    case "usage_update":
      state.usage = { used: update.used, size: update.size }
      return []
    default:
      // plan, mode, config, command and session-info updates carry no transcript content here.
      return []
  }
}

/**
 * ACP `used` is the whole context in use, without a cache breakdown: it reports as uncached input,
 * the side the host reads context size from.
 */
const usage = (state: State): LanguageModelV3Usage => ({
  inputTokens: { total: state.usage?.used, noCache: state.usage?.used, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
})

const providerState = (state: State) =>
  state.provider && state.contextPercent !== undefined ? { contextPercent: state.contextPercent } : undefined

/**
 * What the turn's `finish` part would report if the turn ended now. Undefined until the agent has
 * reported context use, or when unchanged since the last take.
 */
export const takeUsage = (state: State) => {
  if (state.usage === undefined && state.contextPercent === undefined) return undefined
  const live = { usage: usage(state), providerState: providerState(state) }
  const serialized = JSON.stringify(live)
  if (serialized === state.reportedUsage) return undefined
  state.reportedUsage = serialized
  return live
}

const REASON: Record<StopReason, "stop" | "length" | "other"> = {
  end_turn: "stop",
  max_tokens: "length",
  max_turn_requests: "length",
  refusal: "other",
  cancelled: "other",
}

/** Closes the turn: settles tools the agent never reported, then the finish part. */
export const finish = (state: State, stopReason: StopReason): LanguageModelV3StreamPart[] => {
  const parts = close(state)
  for (const [id, call] of state.tools)
    if (!call.settled) {
      call.settled = true
      state.host?.take(id)
      parts.push({
        type: "tool-result",
        toolCallId: id,
        toolName: call.name,
        result: stopReason === "cancelled" ? "Cancelled." : "The agent did not report a result.",
        isError: true,
      } as LanguageModelV3StreamPart)
    }
  const metadata = providerState(state)
  parts.push({
    type: "finish",
    finishReason: { unified: REASON[stopReason], raw: stopReason },
    usage: usage(state),
    ...(metadata ? { providerMetadata: { [state.provider!]: metadata } } : {}),
  } as LanguageModelV3StreamPart)
  return parts
}
