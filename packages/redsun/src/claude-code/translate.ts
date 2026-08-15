import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { LLMEvent, Usage } from "@opencode-ai/llm"
import { SUBAGENT_TOOLS, taskChildMetadata, type TaskChild } from "./subagents"

/**
 * Pure state machine translating Claude Agent SDK messages into the LLMEvent
 * stream SessionProcessor consumes. Claude Code executes its own tools, so
 * every tool event carries `providerExecuted: true` — the processor persists
 * them as completed foreign tool parts and the turn loop never tries to
 * continue them.
 *
 * Streaming fidelity comes from `stream_event` frames
 * (`includePartialMessages: true`); full `assistant` messages supply the
 * authoritative tool_use inputs and full `user` messages supply tool_results.
 * Subagent-attributed frames (`parent_tool_use_id` set) are dropped from the
 * parent's event stream — subagents.ts mirrors them into real child sessions.
 * The main-thread Task tool is emitted as redsun's `task` tool with the
 * mirrored child's `sessionId` in its metadata, which is exactly the contract
 * the TUI's native subagent frontend renders.
 */

type OpenBlock =
  | { kind: "text" | "reasoning"; id: string }
  | { kind: "tool"; id: string; name: string }
  | { kind: "ignored" }

export interface State {
  toolNames: Map<string, string>
  openBlocks: Map<number, OpenBlock>
  messageId: string
  claudeSessionID?: string
  result?: SDKResultMessage
  /** Raw API usage of the turn's most recent main-thread assistant message. */
  lastCallUsage?: Record<string, unknown>
  /**
   * Final output_tokens of the turn's most recent completed main-thread API
   * call, from its message_delta stream event (assistant frames snapshot
   * output_tokens before the message finishes streaming).
   */
  lastCallOutput?: number
  /** Mirrored subagent sessions keyed by Task tool_use id (see subagents.ts). */
  taskChildren?: ReadonlyMap<string, TaskChild>
}

export function makeState(taskChildren?: ReadonlyMap<string, TaskChild>): State {
  return { toolNames: new Map(), openBlocks: new Map(), messageId: "claude", taskChildren }
}

/**
 * Claude Code's subagent tool (Task/Agent) surfaces as redsun's `task` tool:
 * its input shape (description/subagent_type) matches, and the mirrored child
 * session id in the part metadata is what activates the TUI's subagent
 * renderer.
 */
const emittedToolName = (name: string) => (SUBAGENT_TOOLS.has(name) ? "task" : name)

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content)
  return content
    .map((item) => {
      if (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item)
        return String(item.text)
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function mapUsage(usage: Record<string, unknown> | undefined): Usage | undefined {
  if (!usage) return undefined
  const number = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : undefined)
  const nonCached = number("input_tokens")
  const cacheRead = number("cache_read_input_tokens")
  const cacheWrite = number("cache_creation_input_tokens")
  const outputTokens = number("output_tokens")
  const inputTokens =
    nonCached === undefined && cacheRead === undefined && cacheWrite === undefined
      ? undefined
      : (nonCached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  return new Usage({
    inputTokens,
    outputTokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    totalTokens:
      inputTokens === undefined && outputTokens === undefined ? undefined : (inputTokens ?? 0) + (outputTokens ?? 0),
  })
}

const TOOL_USE_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"])

const INTERRUPT_PATTERN = /request was aborted|interrupted by user|aborted/i

function isInterruptedResult(result: SDKResultMessage): boolean {
  if ("terminal_reason" in result && typeof result.terminal_reason === "string") {
    if (result.terminal_reason.startsWith("aborted")) return true
  }
  if (result.subtype === "error_during_execution" && !result.is_error) return true
  if ("errors" in result && Array.isArray(result.errors)) {
    return result.errors.some((error) => INTERRUPT_PATTERN.test(String(error)))
  }
  return false
}

export function resultErrorMessage(result: SDKResultMessage): string {
  const errors = "errors" in result && Array.isArray(result.errors) ? result.errors.map(String) : []
  // CLI-internal diagnostics must never become the user-facing error banner.
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

function contentBlockStart(state: State, index: number, block: Record<string, any>): LLMEvent[] {
  const blockId = `${state.messageId}:${index}`
  switch (block.type) {
    case "text":
      state.openBlocks.set(index, { kind: "text", id: blockId })
      return [LLMEvent.textStart({ id: blockId })]
    case "thinking":
      state.openBlocks.set(index, { kind: "reasoning", id: blockId })
      return [LLMEvent.reasoningStart({ id: blockId })]
    default:
      if (TOOL_USE_TYPES.has(block.type) && typeof block.id === "string" && typeof block.name === "string") {
        const name = emittedToolName(block.name)
        state.toolNames.set(block.id, name)
        state.openBlocks.set(index, { kind: "tool", id: block.id, name })
        return [LLMEvent.toolInputStart({ id: block.id, name })]
      }
      state.openBlocks.set(index, { kind: "ignored" })
      return []
  }
}

function contentBlockDelta(state: State, index: number, delta: Record<string, any>): LLMEvent[] {
  const open = state.openBlocks.get(index)
  if (!open || open.kind === "ignored") return []
  switch (delta.type) {
    case "text_delta":
      return open.kind === "text" ? [LLMEvent.textDelta({ id: open.id, text: String(delta.text ?? "") })] : []
    case "thinking_delta":
      return open.kind === "reasoning"
        ? [LLMEvent.reasoningDelta({ id: open.id, text: String(delta.thinking ?? "") })]
        : []
    case "input_json_delta":
      return open.kind === "tool"
        ? [LLMEvent.toolInputDelta({ id: open.id, name: open.name, text: String(delta.partial_json ?? "") })]
        : []
    default:
      return []
  }
}

function contentBlockStop(state: State, index: number): LLMEvent[] {
  const open = state.openBlocks.get(index)
  state.openBlocks.delete(index)
  if (!open || open.kind === "ignored") return []
  switch (open.kind) {
    case "text":
      return [LLMEvent.textEnd({ id: open.id })]
    case "reasoning":
      return [LLMEvent.reasoningEnd({ id: open.id })]
    case "tool":
      return [LLMEvent.toolInputEnd({ id: open.id, name: open.name })]
  }
}

function streamEvent(state: State, event: Record<string, any>): LLMEvent[] {
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

function assistantMessage(state: State, content: unknown): LLMEvent[] {
  if (!Array.isArray(content)) return []
  const events: LLMEvent[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const item = block as Record<string, any>
    if (!TOOL_USE_TYPES.has(item.type)) continue
    if (typeof item.id !== "string" || typeof item.name !== "string") continue
    const name = emittedToolName(item.name)
    state.toolNames.set(item.id, name)
    const child = SUBAGENT_TOOLS.has(item.name) ? state.taskChildren?.get(item.id) : undefined
    events.push(
      LLMEvent.toolCall({
        id: item.id,
        name,
        input: item.input ?? {},
        providerExecuted: true,
        ...(child ? { providerMetadata: { redsun: taskChildMetadata(child) } } : {}),
      }),
    )
  }
  return events
}

function userMessage(state: State, message: Record<string, any>): LLMEvent[] {
  const content = message.message?.content
  if (!Array.isArray(content)) return []
  const events: LLMEvent[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const item = block as Record<string, any>
    if (item.type !== "tool_result" || typeof item.tool_use_id !== "string") continue
    const name = state.toolNames.get(item.tool_use_id)
    if (!name) continue
    const child = state.taskChildren?.get(item.tool_use_id)
    if (child && !item.is_error) {
      // Structured completion so the task part's completed state keeps the
      // child session link (processor's toolResultOutput lifts output/title/
      // metadata records verbatim). AgentOutput totals ride along when the
      // SDK attached them.
      const agentOutput =
        message.tool_use_result && typeof message.tool_use_result === "object"
          ? (message.tool_use_result as Record<string, any>)
          : undefined
      events.push(
        LLMEvent.toolResult({
          id: item.tool_use_id,
          name,
          result: {
            type: "json",
            value: {
              output: toolResultText(item.content),
              title: child.description,
              metadata: {
                ...taskChildMetadata(child),
                ...(agentOutput?.status === "completed" && typeof agentOutput.totalToolUseCount === "number"
                  ? { toolcalls: agentOutput.totalToolUseCount }
                  : {}),
                ...(agentOutput?.status === "completed" && typeof agentOutput.totalDurationMs === "number"
                  ? { duration: agentOutput.totalDurationMs }
                  : {}),
              },
            },
          },
          providerExecuted: true,
        }),
      )
      continue
    }
    events.push(
      LLMEvent.toolResult({
        id: item.tool_use_id,
        name,
        result: {
          type: item.is_error ? "error" : "text",
          value: toolResultText(item.content),
        },
        providerExecuted: true,
      }),
    )
  }
  return events
}

/**
 * Usage for the turn's step-finish/finish events. `result.usage` sums every
 * API call in the turn, so its cache reads count the whole context once per
 * tool round-trip — a long turn reports millions of "context" tokens. The
 * last main-thread assistant message carries the final call's real input-side
 * usage; output tokens come from that call's message_delta stream event (the
 * API's final per-call count). `result.usage.output_tokens` is only a
 * fallback when no stream events arrived — it is cumulative across calls, and
 * intermediate outputs are already re-counted inside the final call's
 * input/cache tokens, so using it would double-count them.
 */
function turnUsage(state: State, result: SDKResultMessage): Usage | undefined {
  const resultUsage =
    "usage" in result && result.usage && typeof result.usage === "object"
      ? (result.usage as Record<string, unknown>)
      : undefined
  if (!state.lastCallUsage) return mapUsage(resultUsage)
  const resultOutput = resultUsage?.["output_tokens"]
  const output = state.lastCallOutput ?? (typeof resultOutput === "number" ? resultOutput : undefined)
  return mapUsage({
    ...state.lastCallUsage,
    ...(output !== undefined ? { output_tokens: output } : {}),
  })
}

function resultMessage(state: State, result: SDKResultMessage): LLMEvent[] {
  state.result = result
  const usage = turnUsage(state, result)
  if (result.subtype === "success" || isInterruptedResult(result)) {
    return [
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
      LLMEvent.finish({ reason: "stop", usage }),
    ]
  }
  return [LLMEvent.providerError({ message: resultErrorMessage(result), retryable: false })]
}

/**
 * A manual `/compact` renders as a short text part on the compaction message.
 * Auto-compaction happens mid-turn inside Claude Code and stays silent — the
 * next turn's usage reflects it.
 */
function compactBoundary(state: State, message: Record<string, any>): LLMEvent[] {
  const meta = message.compact_metadata
  if (!meta || typeof meta !== "object" || meta.trigger !== "manual") return []
  const before = typeof meta.pre_tokens === "number" ? meta.pre_tokens : undefined
  const after = typeof meta.post_tokens === "number" ? meta.post_tokens : undefined
  const detail =
    before !== undefined && after !== undefined
      ? ` (${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")} conversation tokens)`
      : ""
  const id = `${state.messageId}:compact`
  const text = `Claude Code compacted its session history${detail}.`
  return [LLMEvent.textStart({ id }), LLMEvent.textDelta({ id, text }), LLMEvent.textEnd({ id })]
}

/** Translate one SDK message into zero or more LLMEvents. */
export function translate(state: State, message: SDKMessage): LLMEvent[] {
  if ("session_id" in message && typeof message.session_id === "string" && message.session_id)
    state.claudeSessionID = message.session_id

  switch (message.type) {
    case "stream_event":
      if (message.parent_tool_use_id) return []
      return streamEvent(state, message.event as unknown as Record<string, any>)
    case "assistant": {
      if (message.parent_tool_use_id) return []
      const inner = message.message as Record<string, any>
      if (inner?.usage && typeof inner.usage === "object") state.lastCallUsage = inner.usage
      return assistantMessage(state, inner?.content)
    }
    case "user":
      if (message.parent_tool_use_id) return []
      return userMessage(state, message as unknown as Record<string, any>)
    case "system":
      if ((message as Record<string, any>).subtype === "compact_boundary")
        return compactBoundary(state, message as unknown as Record<string, any>)
      return []
    case "result":
      return resultMessage(state, message)
    default:
      return []
  }
}

export * as ClaudeCodeTranslate from "./translate"
