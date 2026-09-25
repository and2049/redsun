export * as ClaudeCodeLanguageModel from "./language-model.js"

import type { LanguageModelV3CallOptions, LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { DelegatedStreamResult, DelegatedSystemPrompt, DelegatedTurn } from "@opencode/plugin/effect/delegate"
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk"
import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeModels } from "./models.js"
import { ClaudeCodeProfiles } from "./profiles.js"
import type { ClaudeCodeSessions } from "./sessions.js"
import type { Tool } from "@opencode/schema/tool"
import { ClaudeCodeTranslate } from "./translate.js"
import { ClaudeCodeTurnBrief } from "./turn-brief.js"
import PLAN_WORKFLOW from "./prompt/plan-workflow.txt" with { type: "text" }
import BEHAVIOR from "./prompt/behavior.txt" with { type: "text" }

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
  /**
   * The host base prompt for a process about to start (profile `redsun` only), computed after
   * `prepareTurn` bound the served tools. The CLI records it on the session's first request.
   */
  readonly systemPrompt?: (sessionID: string) => Promise<DelegatedSystemPrompt | undefined>
  readonly taskChildren?: (sessionID: string) => ReadonlyMap<string, ClaudeCodeTranslate.TaskChild> | undefined
  /** What the native session still owes once a result lands; see ClaudeCodeSessions.HoldReason. */
  readonly turnPending?: (sessionID: string) => ClaudeCodeSessions.HoldReason
  readonly observer?: (sessionID: string, message: SDKMessage, inTurn: boolean) => Promise<void> | void
  readonly resumeCursor?: (sessionID: string) => string | undefined
  readonly onCursor?: (sessionID: string, claudeSessionID: string) => void
  /** Extra one-shot policy; every non-primary request kind is already one-shot. */
  readonly isOneShot?: (turn: DelegatedTurn) => boolean
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
  readonly behavior?: ClaudeCodeProfiles.Name
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
    ...(config.configDir ? { env: { ...process.env, ...config.env, CLAUDE_CONFIG_DIR: config.configDir } } : {}),
    ...(config.env && !config.configDir ? { env: { ...process.env, ...config.env } } : {}),
    ...extraArgs(config.extraArgs),
  }) as Options

/** The profile's system prompt: redsun's own base prompt split at the cache boundary, or the preset. */
export const systemPrompt = (
  profile: ClaudeCodeProfiles.Profile,
  host?: DelegatedSystemPrompt,
): Options["systemPrompt"] => {
  if (profile.systemPrompt === "host")
    return host ? [...host.static, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...host.dynamic] : undefined
  return {
    type: "preset",
    preset: "claude_code",
    ...(profile.systemPrompt === "preset-behavior" ? { append: BEHAVIOR } : {}),
  }
}

/** Startup-only options per profile; a live process keeps the ones it started with. */
export const interactiveOptions = (config: Config, host?: DelegatedSystemPrompt): Options => {
  const profile = ClaudeCodeProfiles.resolve(config.behavior)
  const prompt = systemPrompt(profile, host)
  return {
    ...baseOptions(config),
    ...(profile.sdkPlanMode ? { planModeInstructions: PLAN_WORKFLOW } : {}),
    ...(profile.tools ? { tools: [...profile.tools] } : {}),
    ...(profile.disallowedTools.length ? { disallowedTools: [...profile.disallowedTools] } : {}),
    ...(Object.keys(profile.toolAliases).length ? { toolAliases: { ...profile.toolAliases } } : {}),
    ...(prompt === undefined ? {} : { systemPrompt: prompt }),
    settingSources: ["user", "project", "local"],
  } as Options
}

const errorStream = (message: string): ReadableStream<LanguageModelV3StreamPart> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      controller.enqueue({ type: "error", error: new Error(message) })
      controller.close()
    },
  })

export interface Model {
  readonly modelID: string
  readonly stream: (turn: DelegatedTurn, options: LanguageModelV3CallOptions) => Promise<DelegatedStreamResult>
}

export const make = (input: {
  readonly modelID: string
  readonly config: Config
  readonly manager: ClaudeCodeSessions.SessionManager
  readonly createQuery: ClaudeCodeSessions.CreateQuery
  readonly hooks?: Hooks
}): Model => {
  const { modelID, config, manager, createQuery, hooks } = input

  const stream = async (turn: DelegatedTurn, options: LanguageModelV3CallOptions): Promise<DelegatedStreamResult> => {
    const sessionID = turn.sessionID
    const oneShot = turn.kind !== "primary" || hooks?.isOneShot?.(turn) === true
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
          planModeInstructions: PLAN_WORKFLOW,
          model: ClaudeCodeModels.cliModel(modelID),
          maxTurns: 1,
          // Never load built-in tool definitions for a one-shot.
          tools: [],
          allowedTools: [],
          strictMcpConfig: true,
          persistSession: false,
        } as Options,
      })
      return { stream: toStream(run, state), request: {}, response: {} }
    }

    const resume = hooks?.resumeCursor?.(sessionID)
    const profile = ClaudeCodeProfiles.resolve(config.behavior)
    // redsun's plan agent is the host's (D4): the CLI always runs in manual mode.
    const permissionMode =
      profile.name === "redsun"
        ? "default"
        : ((await hooks?.permissionMode?.(sessionID)) ?? ((config.permissionMode ?? "default") as PermissionMode))
    const release = await hooks?.prepareTurn?.(
      sessionID,
      turn.assistantMessageID ?? "",
      options.abortSignal ?? new AbortController().signal,
      permissionMode,
      options.toolChoice?.type === "none"
        ? []
        : (options.tools ?? []).flatMap((tool) => (tool.type === "function" ? [tool.name] : [])),
    )
    const freshProcess = manager.willStart(sessionID, permissionMode)
    // Only a starting process takes startup options; compute the prompt before context preparation.
    const host =
      profile.systemPrompt === "host" && freshProcess
        ? await (hooks?.systemPrompt?.(sessionID) ?? Promise.resolve(undefined)).catch((error) => {
            release?.()
            throw error
          })
        : undefined
    const context = await hooks?.context?.(sessionID, freshProcess).catch((error) => {
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
    let native: AsyncIterable<SDKMessage>
    let compacted = 0
    const restoredBefore = hooks?.compactRestored?.(sessionID) ?? 0
    const preToolUse = hooks?.preToolUse?.(sessionID)
    const postToolUse = hooks?.postToolUse?.(sessionID)
    const userPromptSubmit = hooks?.userPromptSubmit?.(sessionID)
    const sessionStart = hooks?.sessionStart?.(sessionID)
    const canUseTool = hooks?.canUseTool?.(sessionID)
    try {
      native = await manager.turn(sessionID, content, {
        model: ClaudeCodeModels.cliModel(modelID),
        permissionMode,
        observer:
          hooks?.observer || hooks?.onModelSubstituted
            ? (message, inTurn) => {
                watchServedModel(message)
                return hooks?.observer?.(sessionID, message, inTurn)
              }
            : undefined,
        holdTurn: hooks?.turnPending ? () => hooks.turnPending!(sessionID) : undefined,
        onExit: hooks?.onExit ? () => hooks.onExit!(sessionID) : undefined,
        options: {
          ...interactiveOptions(config, host),
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
        native,
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

  return { modelID, stream }
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
