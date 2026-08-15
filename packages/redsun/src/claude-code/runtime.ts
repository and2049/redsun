import { query, type Options, type PermissionMode, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { LLMEvent } from "@opencode-ai/llm"
import type { ModelMessage } from "ai"
import { Context, Effect, Exit, Layer } from "effect"
import * as Stream from "effect/Stream"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { Storage } from "@/storage/storage"
import type { LLM } from "@/session/llm"
import { ClaudeCodeExecutable } from "./executable"
import { ClaudeCodeMcp } from "./mcp"
import { ClaudeCodeModels } from "./models"
import { ClaudeCodeModes } from "./modes"
import { makeCanUseTool, type TurnContext } from "./permissions"
import { SessionManager, type CreateQuery, type QueryLike } from "./sessions"
import { ClaudeCodeSubagents } from "./subagents"
import { ClaudeCodeTranslate } from "./translate"
import PLAN_WORKFLOW from "./prompt/plan-workflow.txt"

/**
 * Delegated Claude Code runtime. Requests for the `claude-code` provider
 * divert here from LLM.Service before any AI SDK resolution: Claude Code runs
 * its own agentic loop (its tools, its preset system prompt) and this adapter
 * renders the session back into redsun's LLMEvent contract.
 */

export interface Interface {
  readonly stream: (input: LLM.StreamRequest) => Stream.Stream<LLMEvent, unknown>
  readonly isDelegated: (model: { providerID: string }) => boolean
}

export class Service extends Context.Service<Service, Interface>()("@redsun/ClaudeCode") {}

export const use = serviceUse(Service)

const cursorKey = (sessionID: string) => ["claude_code_session", sessionID]

interface Cursor {
  claudeSessionID: string
  model: string
}

interface InstanceData {
  manager: SessionManager
  contexts: Map<string, TurnContext>
  /** Last agent each session ran under, so the mode brief is sent on change. */
  agents: Map<string, string>
  /** Mirrors Claude Code's built-in Task subagents into redsun child sessions. */
  mirror: ClaudeCodeSubagents.Mirror
}

/** Anthropic content block accepted by the CLI's stream-json input. */
type PromptBlock = Exclude<SDKUserMessage["message"]["content"], string>[number]

export interface PromptContent {
  text: string
  /** Attachment blocks (images/PDFs) sent after the text block. */
  blocks: PromptBlock[]
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
        ? String(part.text)
        : "",
    )
    .filter(Boolean)
    .join("\n")
}

function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+)(?:;[^,]*)*;base64,(.+)$/.exec(url)
  return match ? { mediaType: match[1]!, data: match[2]! } : undefined
}

// Exactly Anthropic's Base64ImageSource media_type union; anything else is
// rejected by the CLI and must degrade to a text placeholder instead.
const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/** Attachment blocks for a user message's file parts (images/PDFs). */
function fileBlocks(content: unknown): PromptBlock[] {
  if (!Array.isArray(content)) return []
  const blocks: PromptBlock[] = []
  for (const part of content) {
    if (!part || typeof part !== "object" || part.type !== "file" || typeof part.data !== "string") continue
    const filename = typeof part.filename === "string" ? part.filename : undefined
    const parsed = parseDataUrl(part.data)
    if (!parsed) continue
    if (IMAGE_MEDIA.has(parsed.mediaType)) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: parsed.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: parsed.data,
        },
      })
      continue
    }
    if (parsed.mediaType === "application/pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: parsed.data },
        ...(filename ? { title: filename } : {}),
      })
      continue
    }
    blocks.push({ type: "text", text: `[Attached ${parsed.mediaType}: ${filename ?? "file"}]` })
  }
  return blocks
}

/** User content after the last assistant message — the turn's new prompt. */
export function promptDelta(messages: ModelMessage[]): PromptContent {
  let start = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "assistant") {
      start = index + 1
      break
    }
  }
  const fresh = messages.slice(start).filter((message) => message.role === "user")
  const texts = fresh.map((message) => messageText(message.content)).filter(Boolean)
  const blocks = fresh.flatMap((message) => fileBlocks(message.content))
  if (texts.length || blocks.length) return { text: texts.join("\n\n"), blocks }
  const lastUser = messages.findLast((message) => message.role === "user")
  return lastUser
    ? { text: messageText(lastUser.content), blocks: fileBlocks(lastUser.content) }
    : { text: "", blocks: [] }
}

/** Role-labeled transcript for one-shot internal calls (judge, title, ...). */
function flattenTranscript(messages: ModelMessage[]): PromptContent {
  const text = messages
    .map((message) => {
      const line = messageText(message.content)
      return line ? `${message.role}: ${line}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
  const blocks = messages
    .filter((message) => message.role === "user")
    .flatMap((message) => fileBlocks(message.content))
  return { text, blocks }
}

const defaultCreateQuery: CreateQuery = (input) => {
  // Redsun's compliance posture rests on driving the user's installed Claude
  // Code CLI; without this option the SDK silently spawns its own bundled
  // cli.js, which must never happen.
  if (!input.options.pathToClaudeCodeExecutable)
    throw new Error("Claude Code query is missing pathToClaudeCodeExecutable; refusing to spawn the SDK's bundled CLI")
  return query(input) as QueryLike
}

export function layerWith(createQuery: CreateQuery): Layer.Layer<
  Service,
  never,
  Config.Service | Storage.Service | Permission.Service | Question.Service | Session.Service | SessionStatus.Service
> {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const storage = yield* Storage.Service
      const permission = yield* Permission.Service
      const question = yield* Question.Service
      const sessions = yield* Session.Service
      const sessionStatus = yield* SessionStatus.Service

      const state = yield* InstanceState.make<InstanceData>(
        Effect.fn("ClaudeCode.state")(function* () {
          const data: InstanceData = {
            manager: new SessionManager(createQuery),
            contexts: new Map(),
            agents: new Map(),
            mirror: ClaudeCodeSubagents.make({
              createSession: (input) => sessions.create(input),
              touchSession: sessions.touch,
              updateMessage: sessions.updateMessage,
              updatePart: sessions.updatePart,
              setStatus: sessionStatus.set,
            }),
          }
          yield* Effect.addFinalizer(() => Effect.sync(() => data.manager.stopAll()))
          return data
        }),
      )

      const errorStream = (message: string) =>
        Stream.make(LLMEvent.providerError({ message, retryable: false }) as LLMEvent)

      const baseOptions = Effect.fn("ClaudeCode.baseOptions")(function* (executablePath: string) {
        const cfg = yield* config.get()
        const cc = cfg.claude_code ?? {}
        const instance = yield* InstanceState.context
        return {
          cc,
          instance,
          options: {
            cwd: instance.directory,
            pathToClaudeCodeExecutable: executablePath,
            env: {
              ...process.env,
              ...cc.env,
              ...(cc.config_dir ? { CLAUDE_CONFIG_DIR: cc.config_dir } : {}),
            },
            ...(cc.extra_args ? { extraArgs: cc.extra_args } : {}),
          } satisfies Partial<Options>,
        }
      })

      const oneShot = Effect.fn("ClaudeCode.oneShot")(function* (
        input: LLM.StreamRequest,
        executablePath: string,
      ) {
        const base = yield* baseOptions(executablePath)
        const state = ClaudeCodeTranslate.makeState()
        const flattened = flattenTranscript(input.messages)
        // Attachment blocks need the streaming-input form; keep the plain
        // string otherwise so the common case is byte-identical to before.
        const prompt: string | AsyncIterable<SDKUserMessage> = flattened.blocks.length
          ? (async function* () {
              yield {
                type: "user" as const,
                message: {
                  role: "user" as const,
                  content: [
                    ...(flattened.text ? [{ type: "text" as const, text: flattened.text }] : []),
                    ...flattened.blocks,
                  ],
                },
                parent_tool_use_id: null,
              }
            })()
          : flattened.text
        const handle = createQuery({
          prompt,
          options: {
            ...base.options,
            model: ClaudeCodeModels.sdkModel(input.model.id),
            systemPrompt: input.system.length ? input.system.join("\n") : undefined,
            tools: [],
            mcpServers: {},
            strictMcpConfig: true,
            persistSession: false,
            maxTurns: 1,
            includePartialMessages: true,
          },
        })
        return Stream.fromAsyncIterable(handle, (error) =>
          error instanceof Error ? error : new Error(String(error)),
        ).pipe(
          Stream.flatMap((message) => Stream.fromIterable(ClaudeCodeTranslate.translate(state, message))),
          // close() runs on every exit, including fiber interruption, and is
          // what actually terminates this single-turn process on ctrl+\.
          Stream.ensuring(
            Effect.sync(() => {
              try {
                handle.close()
              } catch {
                // already gone
              }
            }),
          ),
        )
      })

      const interactive = Effect.fn("ClaudeCode.interactive")(function* (
        input: LLM.StreamRequest,
        executablePath: string,
      ) {
        const data = yield* InstanceState.get(state)
        if (data.manager.busy(input.sessionID))
          return errorStream("Claude Code session is already processing a turn; wait for it to finish.")

        const base = yield* baseOptions(executablePath)
        const bridge = yield* EffectBridge.make()
        const sessionID = SessionID.make(input.sessionID)
        const isWorker = input.parentSessionID !== undefined

        const mainMode: PermissionMode = base.cc.permission_mode ?? "default"
        const workerMode = base.cc.worker_permission_mode ?? "inherit"
        // Plan mode is Claude Code's own read-only mode and must never be
        // weakened by `claude_code.permission_mode`, or an acceptEdits /
        // bypassPermissions session would edit files while redsun shows plan.
        const permissionMode: PermissionMode =
          input.agent.name === "plan"
            ? "plan"
            : isWorker
              ? workerMode === "inherit"
                ? mainMode
                : workerMode
              : mainMode

        const cursor = yield* storage.read<Cursor>(cursorKey(input.sessionID)).pipe(Effect.option)
        const resume = cursor._tag === "Some" ? cursor.value.claudeSessionID : undefined

        // Compacting a live delegated session means compacting Claude Code's
        // own history: send the CLI's /compact command instead of redsun's
        // summarize prompt (see compaction.ts). No mode brief, and the agent
        // map entry is dropped so the next turn re-sends its brief into the
        // compacted history. Without a live session to compact (compaction
        // routed here from a non-delegated session), fall through and treat
        // the summarize prompt as a normal turn.
        const passthroughCompact = input.agent.name === "compaction" && resume !== undefined
        if (passthroughCompact) data.agents.delete(input.sessionID)

        const delta: PromptContent = passthroughCompact
          ? { text: "/compact", blocks: [] }
          : promptDelta(input.messages)
        if (!delta.text && !delta.blocks.length) return errorStream("No user prompt to deliver to Claude Code.")

        let promptText = delta.text
        if (!passthroughCompact) {
          const agentChanged = data.agents.get(input.sessionID) !== input.agent.name
          data.agents.set(input.sessionID, input.agent.name)
          const brief = ClaudeCodeModes.brief({
            agent: input.agent,
            isWorker,
            hasRedsunTask: input.tools["task"] !== undefined,
            agentChanged,
          })
          if (brief) promptText = delta.text ? `${brief}\n\n${delta.text}` : brief
        }
        // Plain string when there are no attachments so the common case is
        // unchanged on the wire; otherwise text block first, attachments after.
        const prompt: SDKUserMessage["message"]["content"] = delta.blocks.length
          ? [...(promptText ? [{ type: "text" as const, text: promptText }] : []), ...delta.blocks]
          : promptText

        data.contexts.set(input.sessionID, {
          sessionID,
          agentName: input.agent.name,
          instance: base.instance,
          ruleset: Permission.merge(input.agent.permission ?? [], input.permission ?? []),
          bridge,
          permission,
          question,
          taskTool: input.tools["task"],
          planExitTool: input.tools["plan_exit"],
          messages: input.messages,
          abort: input.abort,
        })

        const getContext = () => data.contexts.get(input.sessionID)
        // `mcpServers` is fixed when the process starts, so it is attached
        // unconditionally: an agent switch mid-session must not leave the
        // routed task tool unreachable. The handler reports unavailability
        // when the turn's agent has no `task` tool.
        const options: Options = {
          ...base.options,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project", "local"],
          planModeInstructions: PLAN_WORKFLOW,
          canUseTool: makeCanUseTool(getContext),
          ...(resume ? { resume } : {}),
          mcpServers: {
            redsun: ClaudeCodeMcp.makeTaskServer({
              getTaskTool: () => getContext()?.taskTool,
              getMessages: () => getContext()?.messages ?? [],
              getAbort: () => getContext()?.abort,
            }),
          },
        }

        const turnInfo: ClaudeCodeSubagents.TurnInfo = {
          sessionID,
          agent: input.agent.name,
          userMessageID: input.user?.id,
          model: { providerID: input.model.providerID, modelID: input.model.id },
          path: { cwd: base.instance.directory, root: base.instance.worktree },
        }
        const translateState = ClaudeCodeTranslate.makeState(data.mirror.children)
        const iterable = yield* Effect.tryPromise({
          try: () =>
            data.manager.turn(input.sessionID, prompt, {
              model: ClaudeCodeModels.sdkModel(input.model.id),
              permissionMode,
              // Every frame — including the ones that arrive BETWEEN turn
              // windows once the CLI async-launches subagents — runs through
              // the mirror from the session pump, awaited before the frame
              // reaches the turn stream. That keeps the mirror-before-
              // translate ordering (the assistant frame announcing a Task
              // tool_use mints its child session before the toolCall event
              // needs the sessionId) and keeps child transcripts, task
              // notifications, and main-thread auto-continuations flowing
              // after the turn's result.
              observer: (message, inTurn) => bridge.promise(data.mirror.onMessage(turnInfo, message, inTurn)),
              options,
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })

        return Stream.make(LLMEvent.stepStart({ index: 0 }) as LLMEvent).pipe(
          Stream.concat(
            Stream.fromAsyncIterable(iterable, (error) =>
              error instanceof Error ? error : new Error(String(error)),
            ).pipe(
              Stream.mapEffect((message) =>
                Effect.gen(function* () {
                  const events = ClaudeCodeTranslate.translate(translateState, message)
                  if (message.type === "result" && translateState.claudeSessionID) {
                    yield* storage
                      .write<Cursor>(cursorKey(input.sessionID), {
                        claudeSessionID: translateState.claudeSessionID,
                        model: input.model.id,
                      })
                      .pipe(Effect.orDie)
                  }
                  return events
                }),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            ),
          ),
          // An abort listener on input.abort cannot work here: the controller
          // only aborts when the outer stream scope closes (llm.ts), which is
          // AFTER this stream's own finalizers run. Detect fiber interruption
          // from the exit instead and send the SDK's interrupt control request
          // so the CLI ends the turn (its `result` clears the busy state).
          Stream.onExit((exit) =>
            Exit.hasInterrupts(exit)
              ? Effect.sync(() => void data.manager.interrupt(input.sessionID).catch(() => {}))
              : Effect.void,
          ),
          // The TurnContext deliberately survives the turn: async-launched
          // subagents and main-thread auto-continuations keep calling tools
          // between turn windows, and canUseTool must still be able to ask
          // permissions for them instead of blanket-denying. The next turn
          // replaces it; instance disposal drops it.
          Stream.ensuring(data.mirror.turnEnded(sessionID)),
        )
      })

      const stream: Interface["stream"] = (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const cfg = yield* config.get()
            const resolution = ClaudeCodeExecutable.resolve(cfg.claude_code?.binary_path)
            if ("error" in resolution) return errorStream(resolution.error)
            if (input.small || input.internal) return yield* oneShot(input, resolution.path)
            return yield* interactive(input, resolution.path)
          }),
        )

      return Service.of({ stream, isDelegated: ClaudeCodeModels.isDelegated })
    }),
  )
}

const layer = layerWith(defaultCreateQuery)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, Storage.node, Permission.node, Question.node, Session.node, SessionStatus.node],
})

export * as ClaudeCode from "./runtime"
