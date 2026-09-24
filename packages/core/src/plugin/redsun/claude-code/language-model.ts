export * as ClaudeCodeLanguageModel from "./language-model.js"

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { SessionModelHeaders } from "../../../session/model-headers.js"
import { ClaudeCodeModels } from "./models.js"
import type { ClaudeCodeSessions } from "./sessions.js"
import type { Tool } from "../../../tool.js"
import { ClaudeCodeTranslate } from "./translate.js"
import { ClaudeCodeTurnBrief } from "./turn-brief.js"
import PLAN_WORKFLOW from "./prompt/plan-workflow.txt" with { type: "text" }
import BEHAVIOR from "./prompt/behavior.txt" with { type: "text" }

export const SESSION_HEADER = "x-opencode-session"
export const MESSAGE_HEADER = "x-opencode-message"

export const sessionIDFrom = (headers: Record<string, string | undefined> | undefined) => {
  if (!headers) return undefined
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === SESSION_HEADER && value) return value
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
  readonly preToolUse?: (sessionID: string) => HookCallback | undefined
  readonly postToolUse?: (sessionID: string) => HookCallback | undefined
  readonly userPromptSubmit?: (sessionID: string) => HookCallback | undefined
  readonly sessionStart?: (sessionID: string) => HookCallback | undefined
  readonly compactRestored?: (sessionID: string) => number
  readonly hostResultMetadata?: (sessionID: string, nativeToolUseID: string) => Tool.Metadata | undefined
  readonly isDirectHostTool?: (sessionID: string, nativeName: string) => boolean
  readonly prepareTurn?: (
    sessionID: string,
    messageID: string,
    signal: AbortSignal,
    permissionMode: PermissionMode,
    availableTools: readonly string[],
  ) => Promise<() => void>
  readonly turnOptions?: (sessionID: string) => Partial<Options>
  readonly taskChildren?: (sessionID: string) => ReadonlyMap<string, ClaudeCodeTranslate.TaskChild> | undefined
  readonly observer?: (sessionID: string, message: SDKMessage, inTurn: boolean) => Promise<void> | void
  readonly resumeCursor?: (sessionID: string) => string | undefined
  readonly onCursor?: (sessionID: string, claudeSessionID: string) => void
  readonly isOneShot?: (sessionID: string) => boolean
  readonly turnBrief?: (sessionID: string) => string | undefined
  readonly context?: (sessionID: string, freshProcess: boolean) => Promise<{ text?: string; delivered: () => void }>
  readonly onTurnEnd?: (sessionID: string) => Promise<void> | void
  readonly onCompacted?: (sessionID: string) => void
  readonly onExit?: (sessionID: string) => Promise<void> | void
  readonly permissionMode?: (sessionID: string) => Promise<PermissionMode>
  readonly onModelSubstituted?: (sessionID: string, input: { requested: string; served: string }) => void
  /** Canonical wire id an alias resolves to, per the CLI's own picker (when known). */
  readonly resolvedModel?: (modelID: string) => string | undefined
}

export interface Config {
  readonly executablePath: string
  readonly cwd: string
  readonly permissionMode?: string
  readonly configDir?: string
  readonly extraArgs?: readonly string[] | Readonly<Record<string, string | null>>
  readonly env?: Record<string, string>
  readonly behavior?: "native" | "redsun"
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
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(config.behavior === "native" ? {} : { append: BEHAVIOR }),
    },
    settingSources: ["user", "project", "local"],
    ...(config.behavior === "native"
      ? {}
      : { disallowedTools: ["TodoWrite", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList"] }),
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
    const state = ClaudeCodeTranslate.makeState(
      children,
      (id) => hooks?.hostResultMetadata?.(sessionID, id),
      (name) => hooks?.isDirectHostTool?.(sessionID, name) === true,
    )

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
    const permissionMode =
      (await hooks?.permissionMode?.(sessionID)) ?? ((config.permissionMode ?? "default") as PermissionMode)
    const release = await hooks?.prepareTurn?.(
      sessionID,
      options.headers?.[MESSAGE_HEADER] ?? "",
      options.abortSignal ?? new AbortController().signal,
      permissionMode,
      options.toolChoice?.type === "none"
        ? []
        : (options.tools ?? []).flatMap((tool) => (tool.type === "function" ? [tool.name] : [])),
    )
    const context = await hooks?.context?.(sessionID, manager.willStart(sessionID, permissionMode)).catch((error) => {
      release?.()
      throw error
    })
    // The host context goes through the SDK's genuine submission hook. Legacy
    // callers without that hook retain the old brief fallback; never parse or
    // relabel a user-authored <system-update> in the prompt as host context.
    const prompt = hooks?.userPromptSubmit
      ? text
      : ClaudeCodeTurnBrief.prepend(context?.text ?? hooks?.turnBrief?.(sessionID), text)
    const content = [...(prompt ? [{ type: "text" as const, text: prompt }] : []), ...delta.blocks] as Parameters<
      typeof manager.turn
    >[1]
    // The CLI silently serves its default when a pinned id is unknown or not
    // on the subscription; every main-thread assistant frame names the model
    // that actually answered, so a mismatch is only detectable here. Subagent
    // frames (parent_tool_use_id set) legitimately run other models.
    const watchServedModel = (message: SDKMessage) => {
      if (message.type !== "assistant" || message.parent_tool_use_id) return
      const served = message.message?.model
      if (served && ClaudeCodeModels.isSubstituted(modelID, served, hooks?.resolvedModel?.(modelID)))
        hooks?.onModelSubstituted?.(sessionID, { requested: modelID, served })
    }
    let turn: AsyncIterable<SDKMessage>
    let compacted = 0
    const restoredBefore = hooks?.compactRestored?.(sessionID) ?? 0
    const preToolUse = hooks?.preToolUse?.(sessionID)
    const postToolUse = hooks?.postToolUse?.(sessionID)
    const userPromptSubmit = hooks?.userPromptSubmit?.(sessionID)
    const sessionStart = hooks?.sessionStart?.(sessionID)
    const canUseTool = hooks?.canUseTool?.(sessionID)
    try {
      turn = await manager.turn(sessionID, content, {
        model: ClaudeCodeModels.cliModel(modelID),
        permissionMode,
        observer:
          hooks?.observer || hooks?.onModelSubstituted
            ? (message, inTurn) => {
                watchServedModel(message)
                return hooks?.observer?.(sessionID, message, inTurn)
              }
            : undefined,
        onExit: hooks?.onExit ? () => hooks.onExit!(sessionID) : undefined,
        options: {
          ...interactiveOptions(config),
          ...(resume ? { resume } : {}),
          ...(canUseTool ? { canUseTool } : {}),
          ...(preToolUse || postToolUse || userPromptSubmit || sessionStart
            ? {
                hooks: {
                  ...(preToolUse ? { PreToolUse: [{ hooks: [preToolUse] }] } : {}),
                  ...(postToolUse ? { PostToolUse: [{ hooks: [postToolUse] }] } : {}),
                  ...(userPromptSubmit ? { UserPromptSubmit: [{ hooks: [userPromptSubmit] }] } : {}),
                  ...(sessionStart ? { SessionStart: [{ matcher: "compact", hooks: [sessionStart] }] } : {}),
                },
              }
            : {}),
          ...hooks?.turnOptions?.(sessionID),
        } as Options,
      })
    } catch (error) {
      release?.()
      throw error
    }

    const interrupt = () => {
      void manager.interrupt(sessionID).catch(() => {})
    }
    const onAbort = () => interrupt()
    options.abortSignal?.addEventListener("abort", onAbort, { once: true })
    if (options.abortSignal?.aborted) interrupt()

    return {
      stream: toStream(
        turn,
        state,
        async (delivered) => {
          options.abortSignal?.removeEventListener("abort", onAbort)
          if (!userPromptSubmit && delivered && !options.abortSignal?.aborted) context?.delivered()
          if (compacted > (hooks?.compactRestored?.(sessionID) ?? 0) - restoredBefore) hooks?.onCompacted?.(sessionID)
          if (state.claudeSessionID) hooks?.onCursor?.(sessionID, state.claudeSessionID)
          try {
            await hooks?.onTurnEnd?.(sessionID)
          } catch {
          } finally {
            release?.()
          }
        },
        interrupt,
        (message) => {
          if (message.type === "system" && message.subtype === "compact_boundary") compacted++
        },
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
  onDone?: (delivered: boolean) => Promise<void> | void,
  onCancel?: () => void,
  onMessage?: (message: SDKMessage) => void,
): ReadableStream<LanguageModelV3StreamPart> => {
  // After the reader cancels, enqueue/close throw — swallow them so the
  // consuming loop keeps draining and onDone still runs exactly once.
  let closed = false
  let delivered = false
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
        for await (const message of messages) {
          onMessage?.(message)
          if (message.type === "result" && message.subtype === "success") delivered = true
          for (const part of ClaudeCodeTranslate.translate(state, message)) safely(() => controller.enqueue(part))
        }
      } catch (error) {
        safely(() => controller.enqueue({ type: "error", error }))
      } finally {
        await onDone?.(delivered && !closed)
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
