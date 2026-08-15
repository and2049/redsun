import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { SessionID, MessageID, PartID } from "@/session/schema"
import type { SessionStatus } from "@/session/status"
import { nativeResultMetadata, nativeToolInput, nativeToolName } from "./native-tools"

/**
 * Mirrors Claude Code's built-in Task subagents into real redsun child
 * sessions so the TUI's native subagent frontend (click-through, live
 * progress, footer navigation) works for them unchanged.
 *
 * The Agent SDK tags subagent frames with `parent_tool_use_id` (the Task
 * tool_use id) and, with `forwardSubagentText`, forwards the subagent's full
 * conversation. This module consumes those frames before translate.ts (which
 * keeps dropping them from the parent's LLM stream) and authors the child
 * transcript directly through Session.updateMessage/updatePart — the same
 * no-LLM authoring path handleSubtask uses. translate.ts reads the live
 * `children` map to plant `metadata.sessionId` on the parent's task tool
 * part, which is the TUI's click-through gate.
 *
 * Current CLIs async-launch Task subagents: the tool_result returns
 * immediately with status "async_launched" and the main thread's turn ends
 * while the subagents keep running. Everything they emit afterwards — child
 * frames, the settling task_notification, and the main thread's
 * auto-continuation turn that consumes the findings — arrives BETWEEN redsun
 * turn windows. The SessionManager pump feeds those frames here with
 * `inTurn: false`: child mirroring and finalization proceed as usual, and
 * main-thread continuation frames are authored into the parent session
 * directly (there is no live turn stream to translate them), anchored to the
 * last turn's user message.
 *
 * Mirrored child sessions are read-only in effect: redsun never prompts them.
 */

/**
 * Claude Code's built-in subagent tool: named `Task` on older CLIs and
 * `Agent` on current ones (the SDK types call its input AgentInput). Both
 * take {description, prompt, subagent_type} and tag child frames with
 * parent_tool_use_id, so everything downstream treats them identically.
 */
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"])

/** What translate.ts needs to annotate the parent's Task tool events. */
export interface TaskChild {
  sessionID: SessionID
  parentSessionID: SessionID
  description: string
  background?: boolean
}

/** Task part metadata contract shared with translate.ts and the TUI. */
export function taskChildMetadata(child: TaskChild): Record<string, unknown> {
  return {
    sessionId: child.sessionID,
    parentSessionId: child.parentSessionID,
    ...(child.background ? { background: true } : {}),
  }
}

/** Narrow port over Session/SessionStatus so tests need no layers. */
export interface Ops {
  createSession: (input: { parentID: SessionID; title: string; agent: string }) => Effect.Effect<{ id: SessionID }>
  /**
   * Publish a `session.updated` for a fresh child: the TUI's sync store only
   * inserts sessions on that event, so without it the child stays invisible
   * to already-connected clients and child navigation no-ops.
   */
  touchSession: (sessionID: SessionID) => Effect.Effect<void>
  updateMessage: <T extends SessionV1.Info>(msg: T) => Effect.Effect<T>
  updatePart: <T extends SessionV1.Part>(part: T) => Effect.Effect<T>
  setStatus: (sessionID: SessionID, status: SessionStatus.Info) => Effect.Effect<void>
}

/** Per-turn context the mirror needs to mint child sessions and messages. */
export interface TurnInfo {
  sessionID: SessionID
  /** Redsun agent driving the turn; authored continuation messages carry it. */
  agent: string
  /** The turn's user message, anchoring authored continuation assistants. */
  userMessageID?: MessageID
  model: { providerID: SessionV1.Assistant["providerID"]; modelID: SessionV1.Assistant["modelID"] }
  path: { cwd: string; root: string }
}

export interface Mirror {
  /** Live view keyed by Task tool_use id; seeded into translate's State. */
  readonly children: ReadonlyMap<string, TaskChild>
  /**
   * Process one SDK message. `inTurn` is false for frames the session pump
   * sees between turn windows. Never fails: mirror errors are logged and
   * swallowed.
   */
  readonly onMessage: (turn: TurnInfo, message: SDKMessage, inTurn?: boolean) => Effect.Effect<void>
  /** End-of-turn sweep for one redsun session's entries. */
  readonly turnEnded: (sessionID: SessionID) => Effect.Effect<void>
}

interface AssistantState {
  info: SessionV1.Assistant
  /** Exact texts already written for this claude message id, so repeated or cumulative frames don't duplicate parts. */
  seenText: Set<string>
  seenThinking: Set<string>
}

/** One authored message thread: a mirrored child session or a parent continuation. */
interface Transcript {
  sessionID: SessionID
  agent: string
  userMessageID: MessageID
  /** claude assistant message id -> mirrored redsun assistant message */
  assistants: Map<string, AssistantState>
  lastAssistant?: AssistantState
  /** claude tool_use id -> authored tool part */
  toolParts: Map<string, SessionV1.ToolPart>
}

interface Entry {
  child: TaskChild
  transcript: Transcript
  finalized: boolean
}

/** Per-block override of the authored tool name/metadata (continuations map Task -> task). */
type ToolInfo = (block: Record<string, any>) => { tool: string; metadata?: Record<string, unknown> }

const asRecord = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined

function contentBlocks(message: unknown): Record<string, any>[] {
  const content = asRecord(message)?.content
  if (!Array.isArray(content)) return []
  return content.map(asRecord).filter((block): block is Record<string, any> => block !== undefined)
}

function flattenText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content)
  return content
    .map((item) => (asRecord(item)?.type === "text" ? String(asRecord(item)?.text ?? "") : ""))
    .filter(Boolean)
    .join("\n")
}

export function make(ops: Ops): Mirror {
  const entries = new Map<string, Entry>()
  const children = new Map<string, TaskChild>()
  /** Between-turn main-thread threads (auto-continuations), keyed by redsun session. */
  const continuations = new Map<SessionID, Transcript>()

  const createChild = Effect.fn("ClaudeCodeSubagents.createChild")(function* (
    turn: TurnInfo,
    block: Record<string, any>,
  ) {
    const input = asRecord(block.input) ?? {}
    const description = typeof input.description === "string" && input.description ? input.description : "Subagent task"
    const agent = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general"
    const session = yield* ops.createSession({
      parentID: turn.sessionID,
      title: `${description} (@${agent} subagent)`,
      agent,
    })
    const user: SessionV1.User = yield* ops.updateMessage({
      id: MessageID.ascending(),
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent,
      model: { providerID: turn.model.providerID, modelID: turn.model.modelID },
    })
    if (typeof input.prompt === "string" && input.prompt) {
      yield* ops.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: session.id,
        type: "text",
        text: input.prompt,
      } satisfies SessionV1.TextPart)
    }
    yield* ops.setStatus(session.id, { type: "busy" })
    yield* ops.touchSession(session.id)
    const child: TaskChild = { sessionID: session.id, parentSessionID: turn.sessionID, description }
    entries.set(block.id, {
      child,
      transcript: {
        sessionID: session.id,
        agent,
        userMessageID: user.id,
        assistants: new Map(),
        toolParts: new Map(),
      },
      finalized: false,
    })
    children.set(block.id, child)
  })

  const mirrorAssistant = Effect.fn("ClaudeCodeSubagents.mirrorAssistant")(function* (
    turn: TurnInfo,
    transcript: Transcript,
    message: Record<string, any>,
    toolInfo?: ToolInfo,
  ) {
    const claudeMessageID = typeof asRecord(message.message)?.id === "string" ? asRecord(message.message)!.id : "unknown"
    let assistant = transcript.assistants.get(claudeMessageID)
    if (!assistant) {
      const info: SessionV1.Assistant = yield* ops.updateMessage({
        id: MessageID.ascending(),
        sessionID: transcript.sessionID,
        role: "assistant",
        parentID: transcript.userMessageID,
        mode: transcript.agent,
        agent: transcript.agent,
        path: turn.path,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: turn.model.modelID,
        providerID: turn.model.providerID,
        time: { created: Date.now() },
      })
      assistant = { info, seenText: new Set(), seenThinking: new Set() }
      transcript.assistants.set(claudeMessageID, assistant)
    }
    transcript.lastAssistant = assistant

    for (const block of contentBlocks(message.message)) {
      switch (block.type) {
        case "text": {
          const text = String(block.text ?? "")
          if (!text || assistant.seenText.has(text)) break
          assistant.seenText.add(text)
          yield* ops.updatePart({
            id: PartID.ascending(),
            messageID: assistant.info.id,
            sessionID: transcript.sessionID,
            type: "text",
            text,
            time: { start: Date.now(), end: Date.now() },
          } satisfies SessionV1.TextPart)
          break
        }
        case "thinking": {
          const text = String(block.thinking ?? "")
          if (!text || assistant.seenThinking.has(text)) break
          assistant.seenThinking.add(text)
          yield* ops.updatePart({
            id: PartID.ascending(),
            messageID: assistant.info.id,
            sessionID: transcript.sessionID,
            type: "reasoning",
            text,
            time: { start: Date.now(), end: Date.now() },
          } satisfies SessionV1.ReasoningPart)
          break
        }
        case "tool_use": {
          if (typeof block.id !== "string" || typeof block.name !== "string") break
          if (transcript.toolParts.has(block.id)) break
          const info = toolInfo?.(block) ?? { tool: nativeToolName(block.name) }
          const part: SessionV1.ToolPart = yield* ops.updatePart({
            id: PartID.ascending(),
            messageID: assistant.info.id,
            sessionID: transcript.sessionID,
            type: "tool",
            callID: block.id,
            tool: info.tool,
            state: {
              status: "running",
              input: nativeToolInput(block.name, asRecord(block.input) ?? {}),
              ...(info.metadata ? { metadata: info.metadata } : {}),
              time: { start: Date.now() },
            },
            metadata: { providerExecuted: true },
          })
          transcript.toolParts.set(block.id, part)
          break
        }
        default:
          break
      }
    }

    // Per-call usage rides on every subagent assistant frame. tokens.input is
    // non-cached input to match redsun-native semantics (Session.getUsage
    // subtracts cache from inputTokens); output_tokens is the frame's
    // snapshot, close enough for the footer's context readout. Only overwrite
    // when usage is present so a usage-less repeat frame can't zero a real
    // reading.
    const usage = asRecord(asRecord(message.message)?.usage)
    if (usage) {
      const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0)
      assistant.info.tokens = {
        input: count("input_tokens"),
        output: count("output_tokens"),
        reasoning: 0,
        cache: { read: count("cache_read_input_tokens"), write: count("cache_creation_input_tokens") },
      }
    }

    assistant.info.time.completed = Date.now()
    yield* ops.updateMessage(assistant.info)
  })

  const mirrorToolResults = Effect.fn("ClaudeCodeSubagents.mirrorToolResults")(function* (
    transcript: Transcript,
    message: Record<string, any>,
    backgrounded?: (toolUseID: string) => boolean,
  ) {
    for (const block of contentBlocks(message.message)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue
      const part = transcript.toolParts.get(block.tool_use_id)
      if (!part || part.state.status !== "running") continue
      if (backgrounded?.(block.tool_use_id)) {
        // Async launch: the part stays running; tag it so the TUI's
        // background-task rendering (spinner keyed off the child's status)
        // applies to it.
        const updated: SessionV1.ToolPart = yield* ops.updatePart({
          ...part,
          state: { ...part.state, metadata: { ...(part.state.metadata ?? {}), background: true } },
        })
        transcript.toolParts.set(block.tool_use_id, updated)
        continue
      }
      const output = flattenText(block.content)
      const updated: SessionV1.ToolPart = yield* ops.updatePart({
        ...part,
        state: block.is_error
          ? {
              status: "error",
              input: part.state.input,
              error: output || "Tool failed",
              time: { start: part.state.time.start, end: Date.now() },
            }
          : {
              status: "completed",
              input: part.state.input,
              output,
              title: part.state.title ?? part.tool,
              metadata: {
                ...(part.state.metadata ?? {}),
                ...(nativeResultMetadata(part.tool, asRecord(part.state.input) ?? {}, output, message.tool_use_result) ??
                  {}),
              },
              time: { start: part.state.time.start, end: Date.now() },
            },
      })
      transcript.toolParts.set(block.tool_use_id, updated)
    }
  })

  const finalize = Effect.fn("ClaudeCodeSubagents.finalize")(function* (entry: Entry, error?: string) {
    if (entry.finalized) return
    entry.finalized = true
    for (const [id, part] of entry.transcript.toolParts) {
      if (part.state.status !== "running") continue
      entry.transcript.toolParts.set(
        id,
        yield* ops.updatePart({
          ...part,
          state: {
            status: "error",
            input: part.state.input,
            error: error ?? "Task ended",
            time: { start: part.state.time.start, end: Date.now() },
          },
        }),
      )
    }
    if (entry.transcript.lastAssistant) {
      entry.transcript.lastAssistant.info.time.completed = Date.now()
      yield* ops.updateMessage(entry.transcript.lastAssistant.info)
    }
    yield* ops.setStatus(entry.child.sessionID, { type: "idle" })
  })

  /** Continuation thread for between-turn main-thread frames; lazy per session. */
  const continuationFor = (turn: TurnInfo): Transcript | undefined => {
    const existing = continuations.get(turn.sessionID)
    if (existing) return existing
    if (!turn.userMessageID) return undefined
    const transcript: Transcript = {
      sessionID: turn.sessionID,
      agent: turn.agent,
      userMessageID: turn.userMessageID,
      assistants: new Map(),
      toolParts: new Map(),
    }
    continuations.set(turn.sessionID, transcript)
    return transcript
  }

  const closeContinuation = Effect.fn("ClaudeCodeSubagents.closeContinuation")(function* (sessionID: SessionID) {
    const continuation = continuations.get(sessionID)
    if (!continuation) return
    continuations.delete(sessionID)
    if (continuation.lastAssistant) {
      continuation.lastAssistant.info.time.completed = Date.now()
      yield* ops.updateMessage(continuation.lastAssistant.info)
    }
  })

  /** Continuation Task blocks author redsun's `task` part with the child link. */
  const continuationToolInfo: ToolInfo = (block) => {
    if (!SUBAGENT_TOOLS.has(block.name)) return { tool: nativeToolName(block.name) }
    const child = typeof block.id === "string" ? children.get(block.id) : undefined
    return { tool: "task", ...(child ? { metadata: taskChildMetadata(child) } : {}) }
  }

  const handleMessage = Effect.fn("ClaudeCodeSubagents.onMessage")(function* (
    turn: TurnInfo,
    message: SDKMessage,
    inTurn: boolean,
  ) {
    switch (message.type) {
      case "assistant": {
        if (message.parent_tool_use_id) {
          const entry = entries.get(message.parent_tool_use_id)
          if (entry && !entry.finalized) yield* mirrorAssistant(turn, entry.transcript, message as Record<string, any>)
          return
        }
        for (const block of contentBlocks((message as Record<string, any>).message)) {
          if (block.type !== "tool_use" || !SUBAGENT_TOOLS.has(block.name) || typeof block.id !== "string") continue
          if (entries.has(block.id)) continue
          yield* createChild(turn, block)
        }
        // Between turns there is no live turn stream to translate main-thread
        // frames, so author the auto-continuation into the parent directly.
        if (!inTurn) {
          const continuation = continuationFor(turn)
          if (continuation)
            yield* mirrorAssistant(turn, continuation, message as Record<string, any>, continuationToolInfo)
        }
        return
      }
      case "user": {
        if (message.parent_tool_use_id) {
          const entry = entries.get(message.parent_tool_use_id)
          if (entry && !entry.finalized) yield* mirrorToolResults(entry.transcript, message as Record<string, any>)
          return
        }
        const output = asRecord((message as Record<string, any>).tool_use_result)
        const backgrounded = new Set<string>()
        for (const block of contentBlocks((message as Record<string, any>).message)) {
          if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue
          const entry = entries.get(block.tool_use_id)
          if (entry) {
            // Background launch: the tool_result arrives immediately while the
            // subagent keeps running and frames keep flowing.
            if (output?.status === "async_launched") {
              entry.child.background = true
              backgrounded.add(block.tool_use_id)
            } else {
              yield* finalize(entry, block.is_error ? flattenText(block.content) || "Task failed" : undefined)
            }
          }
        }
        if (!inTurn) {
          const continuation = continuations.get(turn.sessionID)
          if (continuation)
            yield* mirrorToolResults(continuation, message as Record<string, any>, (id) => backgrounded.has(id))
        }
        return
      }
      case "system": {
        const system = message as Record<string, any>
        if (system.subtype !== "task_notification" || typeof system.tool_use_id !== "string") return
        const summary = typeof system.summary === "string" ? system.summary : undefined
        const entry = entries.get(system.tool_use_id)
        if (entry) yield* finalize(entry, system.status === "completed" ? undefined : (summary ?? "Task failed"))
        // A continuation-authored task part settles on its notification (the
        // corresponding tool_result never reaches a turn stream).
        const continuation = continuations.get(turn.sessionID)
        const part = continuation?.toolParts.get(system.tool_use_id)
        if (continuation && part && part.state.status === "running") {
          continuation.toolParts.set(
            system.tool_use_id,
            yield* ops.updatePart({
              ...part,
              state:
                system.status === "completed"
                  ? {
                      status: "completed",
                      input: part.state.input,
                      output: summary ?? "",
                      title: part.state.title ?? part.tool,
                      metadata: part.state.metadata ?? {},
                      time: { start: part.state.time.start, end: Date.now() },
                    }
                  : {
                      status: "error",
                      input: part.state.input,
                      error: summary ?? "Task failed",
                      time: { start: part.state.time.start, end: Date.now() },
                    },
            }),
          )
        }
        // Keep the map entry: for foreground tasks the CLI emits the
        // notification BEFORE the main-thread tool_result, and translate
        // still needs the lookup to keep the child link in the completed
        // tool state. The turn-end sweep removes finalized entries.
        return
      }
      case "result": {
        // A between-turn result ends an auto-continuation thread; the next
        // one (another notification, another continuation) starts fresh.
        if (!inTurn) yield* closeContinuation(turn.sessionID)
        return
      }
      default:
        return
    }
  })

  const onMessage: Mirror["onMessage"] = (turn, message, inTurn = true) =>
    handleMessage(turn, message, inTurn).pipe(
      Effect.catchCause((cause) => Effect.logError("claude code subagent mirror failed", { cause })),
    )

  const turnEnded: Mirror["turnEnded"] = (sessionID) =>
    Effect.gen(function* () {
      // Any continuation thread predating this turn is stale — close it so
      // the next between-turn frames start a fresh assistant message.
      yield* closeContinuation(sessionID).pipe(
        Effect.catchCause((cause) => Effect.logError("claude code continuation close failed", { cause })),
      )
      for (const [id, entry] of [...entries]) {
        if (entry.child.parentSessionID !== sessionID) continue
        if (!entry.finalized) {
          if (entry.child.background) continue
          yield* finalize(entry, "Task interrupted").pipe(
            Effect.catchCause((cause) => Effect.logError("claude code subagent sweep failed", { cause })),
          )
        }
        entries.delete(id)
        children.delete(id)
      }
    })

  return { children, onMessage, turnEnded }
}

export * as ClaudeCodeSubagents from "./subagents"
