import { query, type Options, type PermissionMode, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { LLMEvent } from "@opencode-ai/llm"
import type { ModelMessage } from "ai"
import { Context, Effect, Layer } from "effect"
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

/** User text after the last assistant message — the turn's new prompt. */
export function promptDelta(messages: ModelMessage[]): string {
  let start = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "assistant") {
      start = index + 1
      break
    }
  }
  const parts = messages
    .slice(start)
    .filter((message) => message.role === "user")
    .map((message) => messageText(message.content))
    .filter(Boolean)
  if (parts.length) return parts.join("\n\n")
  const lastUser = messages.findLast((message) => message.role === "user")
  return lastUser ? messageText(lastUser.content) : ""
}

/** Role-labeled transcript for one-shot internal calls (judge, title, ...). */
function flattenTranscript(messages: ModelMessage[]): string {
  return messages
    .map((message) => {
      const text = messageText(message.content)
      return text ? `${message.role}: ${text}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
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
        const handle = createQuery({
          prompt: flattenTranscript(input.messages),
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
        const onAbort = () => void handle.interrupt().catch(() => {})
        input.abort.addEventListener("abort", onAbort, { once: true })
        return Stream.fromAsyncIterable(handle, (error) =>
          error instanceof Error ? error : new Error(String(error)),
        ).pipe(
          Stream.flatMap((message) => Stream.fromIterable(ClaudeCodeTranslate.translate(state, message))),
          Stream.ensuring(
            Effect.sync(() => {
              input.abort.removeEventListener("abort", onAbort)
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

        const delta = passthroughCompact ? "/compact" : promptDelta(input.messages)
        if (!delta) return errorStream("No user prompt to deliver to Claude Code.")

        let prompt = delta
        if (!passthroughCompact) {
          const agentChanged = data.agents.get(input.sessionID) !== input.agent.name
          data.agents.set(input.sessionID, input.agent.name)
          const brief = ClaudeCodeModes.brief({
            agent: input.agent,
            isWorker,
            hasRedsunTask: input.tools["task"] !== undefined,
            agentChanged,
          })
          if (brief) prompt = `${brief}\n\n${delta}`
        }

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
          model: { providerID: input.model.providerID, modelID: input.model.id },
          path: { cwd: base.instance.directory, root: base.instance.worktree },
        }
        const translateState = ClaudeCodeTranslate.makeState(data.mirror.children)
        const iterable = yield* Effect.tryPromise({
          try: () =>
            data.manager.turn(input.sessionID, prompt, {
              model: ClaudeCodeModels.sdkModel(input.model.id),
              permissionMode,
              options,
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        })

        const onAbort = () => void data.manager.interrupt(input.sessionID).catch(() => {})
        input.abort.addEventListener("abort", onAbort, { once: true })

        return Stream.make(LLMEvent.stepStart({ index: 0 }) as LLMEvent).pipe(
          Stream.concat(
            Stream.fromAsyncIterable(iterable, (error) =>
              error instanceof Error ? error : new Error(String(error)),
            ).pipe(
              Stream.mapEffect((message) =>
                Effect.gen(function* () {
                  // Mirror before translate: the same assistant frame that
                  // announces a Task tool_use must first mint its child
                  // session so the toolCall event can carry the sessionId.
                  yield* data.mirror.onMessage(turnInfo, message)
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
          Stream.ensuring(
            Effect.sync(() => {
              input.abort.removeEventListener("abort", onAbort)
              data.contexts.delete(input.sessionID)
            }).pipe(Effect.andThen(data.mirror.turnEnded(sessionID))),
          ),
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
