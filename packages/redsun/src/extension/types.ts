import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import type { z } from "zod"

export namespace Extension {
  export type Mode = "tui" | "print" | "rpc"
  export type SourceInfo = { path: string; scope: "user" | "project" | "npm" | "builtin" }
  export type ContextUsage = { tokens: number | null; contextWindow: number; percent: number | null }
  export type Context = {
    mode: Mode
    hasUI: boolean
    cwd: string
    sessionID: string
    agent: string
    signal?: AbortSignal
    isProjectTrusted(): boolean
    getSystemPrompt(): string
    abort(): void
    isIdle(): boolean
    hasPendingMessages(): boolean
    getContextUsage(): ContextUsage | undefined
    getEntries<T = unknown>(customType: string): Promise<Array<{ customType: string; data?: T; details?: T }>>
    compact(): Promise<void>
    ui: {
      notify(message: string, type?: "info" | "warning" | "error"): void
      confirm(title: string, message: string): Promise<boolean>
      input(title: string, placeholder?: string): Promise<string | undefined>
      select(title: string, options: string[]): Promise<string | undefined>
    }
  }
  export type CommandContext = Context & {
    reload(): Promise<void>
    newSession(options?: { parentSession?: string }): Promise<{ sessionID: string }>
    fork(entryId: string): Promise<{ sessionID: string }>
  }
  export type ToolInfo = {
    id: string
    init():
      | Promise<{
          description: string
          parameters: z.ZodObject<any>
          execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult
        }>
      | {
          description: string
          parameters: z.ZodObject<any>
          execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult
        }
  }
  export type RegisteredCommand = {
    name: string
    description?: string
    handler(args: string, ctx: CommandContext): Promise<void> | void
  }

  export type Event =
    | { type: "project_trust"; cwd: string }
    | { type: "resources_discover"; cwd: string; reason: "startup" | "reload" }
    | { type: "agents_register"; cwd: string; reason: "startup" | "reload" }
    | { type: "session_start"; reason: "startup" | "reload" }
    | { type: "session_shutdown"; reason: "quit" | "reload" }
    | { type: "session_before_compact"; sessionID: string; signal: AbortSignal }
    | { type: "session_compact"; sessionID: string; fromExtension: boolean }
    | { type: "context"; messages: unknown[] }
    | { type: "before_agent_start"; prompt: string; systemPrompt: string }
    | { type: "tool_call"; toolCallId: string; toolName: string; input: Record<string, unknown> }
    | {
        type: "tool_result"
        toolCallId: string
        toolName: string
        input: Record<string, unknown>
        output: string
        metadata: Record<string, unknown>
        isError: boolean
      }
    | { type: "turn_start"; turnIndex: number }
    | { type: "turn_end"; turnIndex: number }
    | { type: "input"; text: string }

  export type EventResult =
    | { trusted: "yes" | "no" | "undecided"; remember?: boolean }
    | { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[]; agentPaths?: string[] }
    | { cancel?: boolean; prompt?: string; context?: string[] }
    | { messages?: unknown[] }
    | { systemPrompt?: string }
    | { block?: boolean; reason?: string }
    | { output?: string; metadata?: Record<string, unknown>; isError?: boolean }
    | { action?: "continue" | "handled" | "transform"; text?: string }
    | void
    | undefined

  export type Handler<E extends Event = Event> = (event: E, ctx: Context) => EventResult | Promise<EventResult>
  export type ProviderConfig = Record<string, unknown>
  export interface API {
    on<E extends Event>(event: E["type"], handler: Handler<E>): void
    registerTool(tool: ToolInfo, source?: SourceInfo): Promise<void>
    unregisterTool(id: string): void
    setActiveTools(toolNames: string[]): void
    getActiveTools(): string[]
    getAllTools(): Array<{ id: string; description: string; source: SourceInfo }>
    registerCommand(command: RegisteredCommand): void
    unregisterCommand(name: string): void
    sendMessage(content: string): void
    sendUserMessage(content: string): void
    appendEntry<T = unknown>(sessionID: string, customType: string, data?: T): Promise<string>
    appendCustomMessageEntry<T = unknown>(
      sessionID: string,
      customType: string,
      content: string | Array<{ type: "text"; text: string }>,
      display?: boolean,
      details?: T,
    ): Promise<string>
    setModel(model: string): Promise<boolean>
    registerProvider(name: string, config: ProviderConfig): void
    unregisterProvider(name: string): void
    events: { emit(channel: string, data: unknown): void; on(channel: string, fn: (data: unknown) => void): () => void }
  }
  export type Factory = (api: API) => void | Promise<void>
  export type Loaded = { resolvedPath: string; sourceInfo: SourceInfo; factory: Factory }
}
