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

type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }

const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const base64 = (data: unknown): string | undefined => {
  if (typeof data === "string") return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64")
  return undefined
}

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

export const flattenTranscript = (prompt: LanguageModelV3Prompt): string =>
  prompt
    .map((message) => {
      const line = message.role === "system" ? String(message.content) : partText(message.content)
      return line ? `${message.role}: ${line}` : ""
    })
    .filter(Boolean)
    .join("\n\n")

export interface Hooks {
  readonly canUseTool?: (sessionID: string) => CanUseTool | undefined
  readonly turnOptions?: (sessionID: string) => Partial<Options>
  readonly taskChildren?: (sessionID: string) => ReadonlyMap<string, ClaudeCodeTranslate.TaskChild> | undefined
  readonly observer?: (sessionID: string, message: SDKMessage, inTurn: boolean) => Promise<void> | void
  readonly resumeCursor?: (sessionID: string) => string | undefined
  readonly onCursor?: (sessionID: string, claudeSessionID: string) => void
  readonly isOneShot?: (sessionID: string) => boolean
  readonly turnBrief?: (sessionID: string) => string | undefined
  readonly onTurnEnd?: (sessionID: string) => Promise<void> | void
  readonly onExit?: (sessionID: string) => Promise<void> | void
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
    pathToClaudeCodeExecutable: config.executablePath,
    planModeInstructions: PLAN_WORKFLOW,
    ...(config.configDir ? { env: { ...process.env, ...config.env, CLAUDE_CONFIG_DIR: config.configDir } } : {}),
    ...(config.env && !config.configDir ? { env: { ...process.env, ...config.env } } : {}),
    ...extraArgs(config.extraArgs),
  }) as Options

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
    const delta = oneShot ? { text: flattenTranscript(options.prompt), blocks: [] } : promptDelta(options.prompt)
    const text = delta.text
    if (!text && delta.blocks.length === 0)
      return { stream: errorStream("No user prompt to deliver to Claude Code."), request: {}, response: {} }

    const children = hooks?.taskChildren?.(sessionID)
    const state = ClaudeCodeTranslate.makeState(children)

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
    const permissionMode =
      (await hooks?.permissionMode?.(sessionID)) ?? ((config.permissionMode ?? "default") as PermissionMode)
    const content = [
      ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
      ...delta.blocks,
    ] as Parameters<typeof manager.turn>[1]
    const turn = await manager.turn(sessionID, content, {
      model: ClaudeCodeModels.cliModel(modelID),
      permissionMode,
      observer: hooks?.observer ? (message, inTurn) => hooks.observer!(sessionID, message, inTurn) : undefined,
      onExit: hooks?.onExit ? () => hooks.onExit!(sessionID) : undefined,
      options: {
        ...interactiveOptions(config),
        ...(resume ? { resume } : {}),
        ...(hooks?.canUseTool?.(sessionID) ? { canUseTool: hooks.canUseTool(sessionID) as CanUseTool } : {}),
        ...hooks?.turnOptions?.(sessionID),
      } as Options,
    })

    const interrupt = () => {
      void manager.interrupt(sessionID).catch(() => {
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
          try {
            await hooks?.onTurnEnd?.(sessionID)
          } catch {
          }
        },
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
): ReadableStream<LanguageModelV3StreamPart> => {
  // After the reader cancels, enqueue/close throw — swallow them so the
  // consuming loop keeps draining and onDone still runs exactly once.
  let closed = false
  const safely = (action: () => void) => {
    if (closed) return
    try {
      action()
    } catch {
      closed = true
    }
  }
  return new ReadableStream({
    async start(controller) {
      safely(() => controller.enqueue({ type: "stream-start", warnings: [] }))
      try {
        for await (const message of messages)
          for (const part of ClaudeCodeTranslate.translate(state, message)) safely(() => controller.enqueue(part))
      } catch (error) {
        safely(() => controller.enqueue({ type: "error", error }))
      } finally {
        await onDone?.()
        safely(() => controller.close())
      }
    },
    cancel() {
      closed = true
      onCancel?.()
    },
  })
}

export type { PermissionResult }
