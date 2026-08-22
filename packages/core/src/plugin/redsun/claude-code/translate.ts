export * as ClaudeCodeTranslate from "./translate.js"

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { ClaudeCodeNativeTools } from "./native-tools.js"

type OpenBlock =
  | { kind: "text" | "reasoning"; id: string }
  | { kind: "tool"; id: string; name: string }
  | { kind: "ignored" }

export interface TaskChild {
  readonly sessionID: string
  readonly parentSessionID: string
  readonly description: string
}

export interface State {
  toolCalls: Map<string, { name: string; input: Record<string, unknown> }>
  openBlocks: Map<number, OpenBlock>
  calledToolIds: Set<string>
  messageId: string
  claudeSessionID?: string
  result?: SDKResultMessage
  lastCallUsage?: Record<string, unknown>
  lastCallOutput?: number
  taskChildren?: ReadonlyMap<string, TaskChild>
}

export const makeState = (taskChildren?: ReadonlyMap<string, TaskChild>): State => ({
  toolCalls: new Map(),
  openBlocks: new Map(),
  calledToolIds: new Set(),
  messageId: "claude",
  taskChildren,
})

export const taskChildMetadata = (child: TaskChild) => ({
  sessionID: child.sessionID,
  parentSessionID: child.parentSessionID,
})

const emittedToolName = (name: string) =>
  ClaudeCodeNativeTools.SUBAGENT_TOOLS.has(name) ? "subagent" : ClaudeCodeNativeTools.toolName(name)

const TOOL_USE_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"])

const INTERRUPT_PATTERN = /request was aborted|interrupted by user|aborted/i

const toolResultText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content)
  return content
    .map((item) =>
      item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item
        ? String((item as { text: unknown }).text)
        : "",
    )
    .filter(Boolean)
    .join("\n")
}

const isInterruptedResult = (result: SDKResultMessage): boolean => {
  if ("terminal_reason" in result && typeof result.terminal_reason === "string")
    if (result.terminal_reason.startsWith("aborted")) return true
  if (result.subtype === "error_during_execution" && !result.is_error) return true
  if ("errors" in result && Array.isArray(result.errors))
    return result.errors.some((error) => INTERRUPT_PATTERN.test(String(error)))
  return false
}

export const resultErrorMessage = (result: SDKResultMessage): string => {
  const errors = "errors" in result && Array.isArray(result.errors) ? result.errors.map(String) : []
  const visible = errors.filter((error) => !error.startsWith("[ede_diagnostic]"))
  if (visible.length) return visible[0]!
  switch (result.subtype) {
    case "error_max_turns":
      return "Claude Code stopped after reaching its turn limit."
    case "error_max_budget_usd":
      return "Claude Code stopped after reaching its budget limit."
    default:
      return "Claude Code reported an error while executing the turn."
  }
}

const contentBlockStart = (state: State, index: number, block: Record<string, any>): LanguageModelV3StreamPart[] => {
  const blockId = `${state.messageId}:${index}`
  switch (block.type) {
    case "text":
      state.openBlocks.set(index, { kind: "text", id: blockId })
      return [{ type: "text-start", id: blockId }]
    case "thinking":
      state.openBlocks.set(index, { kind: "reasoning", id: blockId })
      return [{ type: "reasoning-start", id: blockId }]
    default:
      if (TOOL_USE_TYPES.has(block.type) && typeof block.id === "string" && typeof block.name === "string") {
        // The aggregate assistant message can outrun the partial stream; once a
        // tool-call for this id has gone out, the runner treats a late
        // start/delta/end for it as a protocol violation.
        if (state.calledToolIds.has(block.id)) {
          state.openBlocks.set(index, { kind: "ignored" })
          return []
        }
        const name = emittedToolName(block.name)
        state.toolCalls.set(block.id, { name, input: {} })
        state.openBlocks.set(index, { kind: "tool", id: block.id, name })
        return [{ type: "tool-input-start", id: block.id, toolName: name, providerExecuted: true }]
      }
      state.openBlocks.set(index, { kind: "ignored" })
      return []
  }
}

const contentBlockDelta = (state: State, index: number, delta: Record<string, any>): LanguageModelV3StreamPart[] => {
  const open = state.openBlocks.get(index)
  if (!open || open.kind === "ignored") return []
  switch (delta.type) {
    case "text_delta":
      return open.kind === "text" ? [{ type: "text-delta", id: open.id, delta: String(delta.text ?? "") }] : []
    case "thinking_delta":
      return open.kind === "reasoning"
        ? [{ type: "reasoning-delta", id: open.id, delta: String(delta.thinking ?? "") }]
        : []
    case "input_json_delta":
      return open.kind === "tool"
        ? [{ type: "tool-input-delta", id: open.id, delta: String(delta.partial_json ?? "") }]
        : []
    default:
      return []
  }
}

const contentBlockStop = (state: State, index: number): LanguageModelV3StreamPart[] => {
  const open = state.openBlocks.get(index)
  state.openBlocks.delete(index)
  if (!open || open.kind === "ignored") return []
  switch (open.kind) {
    case "text":
      return [{ type: "text-end", id: open.id }]
    case "reasoning":
      return [{ type: "reasoning-end", id: open.id }]
    case "tool":
      return [{ type: "tool-input-end", id: open.id }]
  }
}

const streamEvent = (state: State, event: Record<string, any>): LanguageModelV3StreamPart[] => {
  switch (event.type) {
    case "message_start":
      if (typeof event.message?.id === "string") state.messageId = event.message.id
      return []
    case "content_block_start":
      return contentBlockStart(state, event.index, event.content_block ?? {})
    case "content_block_delta":
      return contentBlockDelta(state, event.index, event.delta ?? {})
    case "content_block_stop":
      return contentBlockStop(state, event.index)
    case "message_delta":
      if (typeof event.usage?.output_tokens === "number") state.lastCallOutput = event.usage.output_tokens
      return []
    default:
      return []
  }
}

const assistantMessage = (state: State, content: unknown): LanguageModelV3StreamPart[] => {
  if (!Array.isArray(content)) return []
  const parts: LanguageModelV3StreamPart[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const item = block as Record<string, any>
    if (!TOOL_USE_TYPES.has(item.type)) continue
    if (typeof item.id !== "string" || typeof item.name !== "string") continue
    const name = emittedToolName(item.name)
    const raw = item.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {}
    const input = ClaudeCodeNativeTools.toolInput(item.name, raw)
    state.toolCalls.set(item.id, { name, input })
    state.calledToolIds.add(item.id)
    for (const [index, open] of state.openBlocks)
      if (open.kind === "tool" && open.id === item.id) state.openBlocks.set(index, { kind: "ignored" })
    parts.push({
      type: "tool-call",
      toolCallId: item.id,
      toolName: name,
      input: JSON.stringify(input),
      providerExecuted: true,
    })
  }
  return parts
}

const userMessage = (state: State, message: Record<string, any>): LanguageModelV3StreamPart[] => {
  const content = message.message?.content
  if (!Array.isArray(content)) return []
  const parts: LanguageModelV3StreamPart[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const item = block as Record<string, any>
    if (item.type !== "tool_result" || typeof item.tool_use_id !== "string") continue
    const call = state.toolCalls.get(item.tool_use_id)
    if (!call) continue
    const child = state.taskChildren?.get(item.tool_use_id)
    const text = toolResultText(item.content)

    if (child && !item.is_error) {
      const output =
        message.tool_use_result && typeof message.tool_use_result === "object"
          ? (message.tool_use_result as Record<string, any>)
          : undefined
      const completed = output?.status === "completed"
      parts.push({
        type: "tool-result",
        toolCallId: item.tool_use_id,
        toolName: call.name,
        result: {
          output: text,
          metadata: {
            ...taskChildMetadata(child),
            ...(completed && typeof output?.totalToolUseCount === "number"
              ? { toolcalls: output.totalToolUseCount }
              : {}),
            ...(completed && typeof output?.totalDurationMs === "number" ? { duration: output.totalDurationMs } : {}),
          },
        },
      })
      continue
    }

    const metadata = item.is_error
      ? undefined
      : ClaudeCodeNativeTools.resultMetadata(call.name, call.input, message.tool_use_result)
    parts.push({
      type: "tool-result",
      toolCallId: item.tool_use_id,
      toolName: call.name,
      result: metadata === undefined ? text : { output: text, metadata },
      ...(item.is_error ? { isError: true } : {}),
    })
  }
  return parts
}

const turnUsage = (state: State, result: SDKResultMessage) => {
  const resultUsage =
    "usage" in result && result.usage && typeof result.usage === "object"
      ? (result.usage as Record<string, unknown>)
      : undefined
  const source = (() => {
    if (!state.lastCallUsage) return resultUsage
    const fallback = resultUsage?.["output_tokens"]
    const output = state.lastCallOutput ?? (typeof fallback === "number" ? fallback : undefined)
    return { ...state.lastCallUsage, ...(output !== undefined ? { output_tokens: output } : {}) }
  })()

  const number = (key: string) => (typeof source?.[key] === "number" ? (source[key] as number) : undefined)
  const noCache = number("input_tokens")
  const cacheRead = number("cache_read_input_tokens")
  const cacheWrite = number("cache_creation_input_tokens")
  const outputTotal = number("output_tokens")
  const inputTotal =
    noCache === undefined && cacheRead === undefined && cacheWrite === undefined
      ? undefined
      : (noCache ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return {
    inputTokens: { total: inputTotal, noCache, cacheRead, cacheWrite },
    outputTokens: { total: outputTotal, reasoning: undefined },
  }
}

const resultMessage = (state: State, result: SDKResultMessage): LanguageModelV3StreamPart[] => {
  state.result = result
  if (result.subtype === "success" || isInterruptedResult(result))
    return [
      {
        type: "finish",
        finishReason: { unified: "stop", raw: result.subtype },
        usage: turnUsage(state, result),
      } as LanguageModelV3StreamPart,
    ]
  return [{ type: "error", error: new Error(resultErrorMessage(result)) }]
}

const compactBoundary = (state: State, message: Record<string, any>): LanguageModelV3StreamPart[] => {
  const meta = message.compact_metadata
  if (!meta || typeof meta !== "object" || meta.trigger !== "manual") return []
  const before = typeof meta.pre_tokens === "number" ? meta.pre_tokens : undefined
  const after = typeof meta.post_tokens === "number" ? meta.post_tokens : undefined
  const detail =
    before !== undefined && after !== undefined
      ? ` (${before.toLocaleString("en-US")} to ${after.toLocaleString("en-US")} conversation tokens)`
      : ""
  const id = `${state.messageId}:compact`
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: `Claude Code compacted its session history${detail}.` },
    { type: "text-end", id },
  ]
}

export const translate = (state: State, message: SDKMessage): LanguageModelV3StreamPart[] => {
  if ("session_id" in message && typeof message.session_id === "string" && message.session_id)
    state.claudeSessionID = message.session_id

  switch (message.type) {
    case "stream_event":
      if (message.parent_tool_use_id) return []
      return streamEvent(state, message.event as unknown as Record<string, any>)
    case "assistant": {
      if (message.parent_tool_use_id) return []
      const inner = message.message as unknown as Record<string, any>
      if (inner?.usage && typeof inner.usage === "object") state.lastCallUsage = inner.usage
      return assistantMessage(state, inner?.content)
    }
    case "user":
      if (message.parent_tool_use_id) return []
      return userMessage(state, message as unknown as Record<string, any>)
    case "system":
      if ((message as unknown as Record<string, any>).subtype === "compact_boundary")
        return compactBoundary(state, message as unknown as Record<string, any>)
      return []
    case "result":
      return resultMessage(state, message)
    default:
      return []
  }
}
