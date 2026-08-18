// REDSUN: the delegated Claude Code provider as a LanguageModelV3.
//
// Claude Code runs its own agentic loop, so this model does not send a system
// prompt or tool schemas for interactive turns — it delivers the user-text delta
// since the last assistant message and streams the CLI's own events back as
// provider-executed parts. gitlab.ts does the same thing for its duo-workflow
// models, so an agentic sub-loop behind a LanguageModelV3 is an upstream-shaped
// pattern rather than a redsun invention.
//
// The redsun session id arrives on `x-opencode-session`, which the session
// runner already sets in SessionModelHeaders. That is what keys the persistent
// CLI process and its resume cursor, and it is why no core edit is needed here.
export * as ClaudeCodeLanguageModel from "./language-model.js"

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import type { CanUseTool, Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeModels } from "./models.js"
import type { ClaudeCodeSessions } from "./sessions.js"
import { ClaudeCodeTranslate } from "./translate.js"

export const SESSION_HEADER = "x-opencode-session"

/** Session id for this request, or undefined for a call made outside a session. */
export const sessionIDFrom = (headers: Record<string, string | undefined> | undefined) => {
  if (!headers) return undefined
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === SESSION_HEADER && value) return value
  return undefined
}

const partText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: string }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n")
}

/**
 * The user text Claude Code has not seen yet: everything after the last
 * assistant message. Claude Code keeps its own conversation, so replaying the
 * whole transcript every turn would duplicate it.
 */
export const promptDelta = (prompt: LanguageModelV3Prompt): string => {
  let start = 0
  for (let index = prompt.length - 1; index >= 0; index--)
    if (prompt[index]!.role === "assistant") {
      start = index + 1
      break
    }
  const fresh = prompt.slice(start).filter((message) => message.role === "user")
  const texts = fresh.map((message) => partText(message.content)).filter(Boolean)
  if (texts.length) return texts.join("\n\n")
  const lastUser = prompt.findLast((message) => message.role === "user")
  return lastUser ? partText(lastUser.content) : ""
}

/** Role-labeled transcript for one-shot calls (title, summary, compaction). */
export const flattenTranscript = (prompt: LanguageModelV3Prompt): string =>
  prompt
    .map((message) => {
      const line = message.role === "system" ? String(message.content) : partText(message.content)
      return line ? `${message.role}: ${line}` : ""
    })
    .filter(Boolean)
    .join("\n\n")

export interface Hooks {
  /** Resolve `canUseTool` for a turn, or undefined to let the CLI decide. */
  readonly canUseTool?: (sessionID: string) => CanUseTool | undefined
  /** Extra SDK options for a turn, e.g. the in-process MCP server. */
  readonly turnOptions?: (sessionID: string) => Partial<Options>
  /** Mirrored subagent sessions for the turn, keyed by subagent tool_use id. */
  readonly taskChildren?: (sessionID: string) => ReadonlyMap<string, ClaudeCodeTranslate.TaskChild> | undefined
  /** Observe every SDK frame, including ones between turn windows. */
  readonly observer?: (sessionID: string, message: SDKMessage, inTurn: boolean) => Promise<void> | void
  /** Persisted Claude Code session id for resume, if any. */
  readonly resumeCursor?: (sessionID: string) => string | undefined
  /** Record the Claude Code session id after a turn so the next one resumes. */
  readonly onCursor?: (sessionID: string, claudeSessionID: string) => void
  /** True when this request is an internal one-shot (title, summary, compaction). */
  readonly isOneShot?: (sessionID: string) => boolean
}

export interface Config {
  readonly executablePath: string
  readonly cwd: string
  readonly permissionMode?: string
  readonly configDir?: string
  readonly extraArgs?: readonly string[]
  readonly env?: Record<string, string>
}

const baseOptions = (config: Config): Options =>
  ({
    cwd: config.cwd,
    // Compliance rests on driving the user's installed CLI; the SDK's bundled
    // cli.js fallback must never be spawned.
    pathToClaudeCodeExecutable: config.executablePath,
    ...(config.configDir ? { env: { ...process.env, ...config.env, CLAUDE_CONFIG_DIR: config.configDir } } : {}),
    ...(config.env && !config.configDir ? { env: { ...process.env, ...config.env } } : {}),
    ...(config.extraArgs?.length ? { extraArgs: Object.fromEntries(config.extraArgs.map((a) => [a, null])) } : {}),
  }) as Options

const errorStream = (message: string): ReadableStream<LanguageModelV3StreamPart> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      controller.enqueue({ type: "error", error: new Error(message) })
      controller.close()
    },
  })

export const make = (input: {
  readonly modelID: string
  readonly config: Config
  readonly manager: ClaudeCodeSessions.SessionManager
  /** Injectable so tests can run one-shot calls against fixture streams. */
  readonly createQuery: ClaudeCodeSessions.CreateQuery
  readonly hooks?: Hooks
}): LanguageModelV3 => {
  const { modelID, config, manager, createQuery, hooks } = input

  const doStream = async (options: LanguageModelV3CallOptions) => {
    const sessionID = sessionIDFrom(options.headers)
    if (!sessionID)
      return {
        stream: errorStream("Claude Code requires a session; this request carried no session id."),
        request: {},
        response: {},
      }

    const oneShot = hooks?.isOneShot?.(sessionID) === true
    const text = oneShot ? flattenTranscript(options.prompt) : promptDelta(options.prompt)
    if (!text)
      return { stream: errorStream("No user prompt to deliver to Claude Code."), request: {}, response: {} }

    const children = hooks?.taskChildren?.(sessionID)
    const state = ClaudeCodeTranslate.makeState(children)

    // Internal calls (title, summary, compaction) must never touch the
    // interactive process: they run one-shot with no tools and no persistence.
    if (oneShot) {
      const run = createQuery({
        prompt: text,
        options: {
          ...baseOptions(config),
          model: ClaudeCodeModels.cliModel(modelID),
          maxTurns: 1,
          allowedTools: [],
          strictMcpConfig: true,
          persistSession: false,
        } as Options,
      })
      return { stream: toStream(run, state), request: {}, response: {} }
    }

    const resume = hooks?.resumeCursor?.(sessionID)
    const turn = await manager.turn(sessionID, [{ type: "text", text }], {
      model: ClaudeCodeModels.cliModel(modelID),
      permissionMode: (config.permissionMode ?? "default") as never,
      observer: hooks?.observer ? (message, inTurn) => hooks.observer!(sessionID, message, inTurn) : undefined,
      options: {
        ...baseOptions(config),
        ...(resume ? { resume } : {}),
        ...(hooks?.canUseTool?.(sessionID) ? { canUseTool: hooks.canUseTool(sessionID) as CanUseTool } : {}),
        ...hooks?.turnOptions?.(sessionID),
      } as Options,
    })

    return {
      stream: toStream(turn, state, () => {
        if (state.claudeSessionID) hooks?.onCursor?.(sessionID, state.claudeSessionID)
      }),
      request: {},
      response: {},
    }
  }

  return {
    specificationVersion: "v3",
    provider: ClaudeCodeModels.PROVIDER_ID,
    modelId: modelID,
    supportedUrls: {},
    doStream,
    // Claude Code is a streaming agent; a non-streaming call is not meaningful
    // and no v2 path takes it (the session runner always streams).
    doGenerate: async () => {
      throw new Error("Claude Code models do not support non-streaming generation")
    },
  } satisfies LanguageModelV3
}

const toStream = (
  messages: AsyncIterable<SDKMessage>,
  state: ClaudeCodeTranslate.State,
  onDone?: () => void,
): ReadableStream<LanguageModelV3StreamPart> =>
  new ReadableStream({
    async start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      try {
        for await (const message of messages)
          for (const part of ClaudeCodeTranslate.translate(state, message)) controller.enqueue(part)
      } catch (error) {
        controller.enqueue({ type: "error", error })
      } finally {
        onDone?.()
        controller.close()
      }
    },
  })

export type { PermissionResult }
