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
import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { SessionModelHeaders } from "../../../session/model-headers.js"
import { ClaudeCodeModels } from "./models.js"
import type { ClaudeCodeSessions } from "./sessions.js"
import { ClaudeCodeTranslate } from "./translate.js"
import { ClaudeCodeTurnBrief } from "./turn-brief.js"
import PLAN_WORKFLOW from "./prompt/plan-workflow.txt" with { type: "text" }

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

/** A content block the SDK accepts on a user message. */
type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }

/** Exactly Anthropic's Base64ImageSource union; anything else degrades to text. */
const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const base64 = (data: unknown): string | undefined => {
  if (typeof data === "string") return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64")
  // A URL is a reference the CLI cannot resolve on our behalf.
  return undefined
}

/**
 * Attachment blocks for a message's file parts.
 *
 * Dropping these was silent: a delegated turn kept the user's words and lost
 * the screenshot they were about.
 */
const fileBlocks = (content: unknown): PromptBlock[] => {
  if (!Array.isArray(content)) return []
  const blocks: PromptBlock[] = []
  for (const part of content) {
    if (!part || typeof part !== "object" || (part as { type?: string }).type !== "file") continue
    const file = part as { data?: unknown; mediaType?: unknown; filename?: unknown }
    const mediaType = typeof file.mediaType === "string" ? file.mediaType : undefined
    const filename = typeof file.filename === "string" ? file.filename : undefined
    const data = base64(file.data)
    if (!mediaType || !data) {
      blocks.push({ type: "text", text: `[Attached file: ${filename ?? "unnamed"}]` })
      continue
    }
    if (IMAGE_MEDIA.has(mediaType)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } })
      continue
    }
    if (mediaType === "application/pdf") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: mediaType, data },
        ...(filename ? { title: filename } : {}),
      })
      continue
    }
    blocks.push({ type: "text", text: `[Attached ${mediaType}: ${filename ?? "file"}]` })
  }
  return blocks
}

export interface PromptContent {
  readonly text: string
  readonly blocks: readonly PromptBlock[]
}

/**
 * The user content Claude Code has not seen yet: everything after the last
 * assistant message. Claude Code keeps its own conversation, so replaying the
 * whole transcript every turn would duplicate it.
 */
export const promptDelta = (prompt: LanguageModelV3Prompt): PromptContent => {
  let start = 0
  for (let index = prompt.length - 1; index >= 0; index--)
    if (prompt[index]!.role === "assistant") {
      start = index + 1
      break
    }
  const fresh = prompt.slice(start).filter((message) => message.role === "user")
  const texts = fresh.map((message) => partText(message.content)).filter(Boolean)
  const blocks = fresh.flatMap((message) => fileBlocks(message.content))
  if (texts.length || blocks.length) return { text: texts.join("\n\n"), blocks }
  const lastUser = prompt.findLast((message) => message.role === "user")
  return lastUser
    ? { text: partText(lastUser.content), blocks: fileBlocks(lastUser.content) }
    : { text: "", blocks: [] }
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
  /**
   * True when this request is an internal one-shot the *session state* reveals
   * -- a `summary` generation, which reaches this provider through the ordinary
   * generate path and so is announced by the session context hook. Requests
   * carrying `SessionModelHeaders.internal` are recognized without asking.
   */
  readonly isOneShot?: (sessionID: string) => boolean
  /**
   * Text to prepend to this turn's prompt. A delegated turn sends no system
   * prompt, so this is the only way an agent's standing instructions reach the
   * CLI. See turn-brief.ts.
   */
  readonly turnBrief?: (sessionID: string) => string | undefined
  /** Turn window closed: the subagent mirror finalizes anything still open. */
  readonly onTurnEnd?: (sessionID: string) => Promise<void> | void
  /**
   * Permission mode for this turn. Async because it resolves the driving
   * agent, which is what lets `plan` override config unweakenably.
   */
  readonly permissionMode?: (sessionID: string) => Promise<PermissionMode>
}

export interface Config {
  readonly executablePath: string
  readonly cwd: string
  readonly permissionMode?: string
  readonly configDir?: string
  readonly extraArgs?: readonly string[] | Readonly<Record<string, string | null>>
  readonly env?: Record<string, string>
}

/**
 * `extraArgs` as the SDK wants it: a flag-to-value map, `null` for a bare flag.
 * The list form cannot express `--foo bar`, so the record form is also accepted.
 */
const extraArgs = (value: Config["extraArgs"]) => {
  if (!value) return {}
  if (Array.isArray(value))
    return value.length ? { extraArgs: Object.fromEntries(value.map((flag) => [flag, null])) } : {}
  const entries = Object.entries(value as Record<string, string | null>)
  return entries.length ? { extraArgs: Object.fromEntries(entries) } : {}
}

const baseOptions = (config: Config): Options =>
  ({
    cwd: config.cwd,
    // Compliance rests on driving the user's installed CLI; the SDK's bundled
    // cli.js fallback must never be spawned.
    pathToClaudeCodeExecutable: config.executablePath,
    // Replaces the body of the CLI's plan-mode reminder. The CLI keeps wrapping
    // it with its own read-only preamble and the ExitPlanMode protocol, so this
    // shapes how a delegated plan session works without weakening what it may
    // touch. Only consulted when `permissionMode` is "plan".
    planModeInstructions: PLAN_WORKFLOW,
    ...(config.configDir ? { env: { ...process.env, ...config.env, CLAUDE_CONFIG_DIR: config.configDir } } : {}),
    ...(config.env && !config.configDir ? { env: { ...process.env, ...config.env } } : {}),
    ...extraArgs(config.extraArgs),
  }) as Options

/**
 * Options for an interactive turn, i.e. one the user is actually talking to.
 *
 * Two of these are what make a delegated session behave like Claude Code at
 * all. The SDK does not send the CLI's system prompt unless asked, so without
 * the preset the delegated agent loses every bit of the CLI's built-in
 * behaviour; and without `settingSources` the CLI reads neither the user's nor
 * the project's `CLAUDE.md` and settings. V1 set both.
 *
 * One-shot calls deliberately get neither: a title or a summary is redsun's
 * question, not a coding turn, and the preset would prepend a system prompt
 * many times longer than the request.
 */
const interactiveOptions = (config: Config): Options =>
  ({
    ...baseOptions(config),
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
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

    const oneShot = SessionModelHeaders.isInternal(options.headers) || hooks?.isOneShot?.(sessionID) === true
    // A one-shot is redsun's own question about the transcript, so it is flat
    // text; an interactive turn carries whatever the user attached.
    const delta = oneShot ? { text: flattenTranscript(options.prompt), blocks: [] } : promptDelta(options.prompt)
    const text = delta.text
    if (!text && delta.blocks.length === 0)
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

    const prompt = ClaudeCodeTurnBrief.prepend(hooks?.turnBrief?.(sessionID), text)
    const resume = hooks?.resumeCursor?.(sessionID)
    // Config is only the fallback: the hook is what makes the plan agent's
    // read-only mode impossible to weaken from redsun.json.
    const permissionMode =
      (await hooks?.permissionMode?.(sessionID)) ?? ((config.permissionMode ?? "default") as PermissionMode)
    // Text block first, attachments after -- the shape the SDK expects, and the
    // one V1 sent.
    const content = [
      ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
      ...delta.blocks,
    ] as Parameters<typeof manager.turn>[1]
    const turn = await manager.turn(sessionID, content, {
      model: ClaudeCodeModels.cliModel(modelID),
      permissionMode,
      observer: hooks?.observer ? (message, inTurn) => hooks.observer!(sessionID, message, inTurn) : undefined,
      options: {
        ...interactiveOptions(config),
        ...(resume ? { resume } : {}),
        ...(hooks?.canUseTool?.(sessionID) ? { canUseTool: hooks.canUseTool(sessionID) as CanUseTool } : {}),
        ...hooks?.turnOptions?.(sessionID),
      } as Options,
    })

    // REDSUN: interrupting has to reach the CLI.
    //
    // Tearing down this stream only ends redsun's view of the turn; the Claude
    // Code process keeps running its agentic loop, editing files for a turn the
    // user already stopped. The SDK's interrupt control request ends it, and its
    // `result` frame clears the busy state so the next turn is accepted.
    const interrupt = () => {
      void manager.interrupt(sessionID).catch(() => {
        // The process may already be gone; nothing left to stop.
      })
    }
    const onAbort = () => interrupt()
    options.abortSignal?.addEventListener("abort", onAbort, { once: true })
    if (options.abortSignal?.aborted) interrupt()

    return {
      stream: toStream(
        turn,
        state,
        async () => {
          options.abortSignal?.removeEventListener("abort", onAbort)
          if (state.claudeSessionID) hooks?.onCursor?.(sessionID, state.claudeSessionID)
          // Sweep after the cursor so a mirror failure cannot lose resume continuity.
          try {
            await hooks?.onTurnEnd?.(sessionID)
          } catch {
            // Mirroring is best-effort and must never fail a completed turn.
          }
        },
        // Cancelling the reader is the other way a turn ends early, and it does
        // not necessarily come with an abort signal.
        interrupt,
      ),
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
  onDone?: () => Promise<void> | void,
  onCancel?: () => void,
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
        await onDone?.()
        controller.close()
      }
    },
    cancel() {
      onCancel?.()
    },
  })

export type { PermissionResult }
