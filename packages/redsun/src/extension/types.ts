import z from "zod"
import type { Tool } from "../tool/tool"

export namespace Extension {
  export type Mode = "tui" | "print" | "rpc"

  export interface UIContext {
    notify(message: string, type?: "info" | "warning" | "error"): void
    confirm(title: string, message: string): Promise<boolean>
    input(title: string, placeholder?: string): Promise<string | undefined>
    select(title: string, options: string[]): Promise<string | undefined>
  }

  export interface ContextUsage {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }

  export interface Context {
    ui: UIContext
    mode: Mode
    hasUI: boolean
    cwd: string
    sessionID: string
    agent: string
    isIdle(): boolean
    isProjectTrusted(): boolean
    signal: AbortSignal | undefined
    abort(): void
    hasPendingMessages(): boolean
    getContextUsage(): ContextUsage | undefined
    getSystemPrompt(): string
    getEntries<T = unknown>(customType: string): Promise<Array<{ customType: string; data?: T; details?: T }>>
  }

  export interface CommandContext extends Context {
    reload(): Promise<void>
  }

  export interface SourceInfo {
    path: string
    scope: "user" | "project" | "npm" | "builtin"
  }

  export interface RegisteredTool {
    tool: Tool.Info
    source: SourceInfo
    description?: string
  }

  export interface RegisteredCommand {
    name: string
    description?: string
    handler: (args: string, ctx: CommandContext) => Promise<void> | void
  }

  // Event types
  export interface ProjectTrustEvent {
    type: "project_trust"
    cwd: string
  }

  export interface ProjectTrustResult {
    trusted: "yes" | "no" | "undecided"
    remember?: boolean
  }

  export interface ResourcesDiscoverEvent {
    type: "resources_discover"
    cwd: string
    reason: "startup" | "reload"
  }

  export interface ResourcesDiscoverResult {
    skillPaths?: string[]
    promptPaths?: string[]
    themePaths?: string[]
  }

  export interface AgentsRegisterEvent {
    type: "agents_register"
    cwd: string
    reason: "startup" | "reload"
  }

  export interface AgentsRegisterResult {
    agentPaths?: string[]
  }

  export interface SessionStartEvent {
    type: "session_start"
    reason: "startup" | "reload" | "new" | "resume" | "fork"
  }

  export interface SessionShutdownEvent {
    type: "session_shutdown"
    reason: "quit" | "reload" | "new" | "resume" | "fork"
  }

  export interface ContextEvent {
    type: "context"
    messages: unknown[]
  }

  export interface ContextEventResult {
    messages?: unknown[]
  }

  export interface BeforeAgentStartEvent {
    type: "before_agent_start"
    prompt: string
    systemPrompt: string
  }

  export interface BeforeAgentStartResult {
    systemPrompt?: string
  }

  export interface ToolCallEvent {
    type: "tool_call"
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
  }

  export interface ToolCallResult {
    block?: boolean
    reason?: string
  }

  export interface ToolResultEvent {
    type: "tool_result"
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    output: string
    metadata: Record<string, unknown>
    isError: boolean
  }

  export interface ToolResultEventResult {
    output?: string
    metadata?: Record<string, unknown>
    isError?: boolean
  }

  export interface TurnStartEvent {
    type: "turn_start"
    turnIndex: number
  }

  export interface TurnEndEvent {
    type: "turn_end"
    turnIndex: number
  }

  export interface InputEvent {
    type: "input"
    text: string
  }

  export interface InputEventResult {
    action?: "continue" | "handled" | "transform"
    text?: string
  }

  export type Event =
    | ProjectTrustEvent
    | ResourcesDiscoverEvent
    | AgentsRegisterEvent
    | SessionStartEvent
    | SessionShutdownEvent
    | ContextEvent
    | BeforeAgentStartEvent
    | ToolCallEvent
    | ToolResultEvent
    | TurnStartEvent
    | TurnEndEvent
    | InputEvent

  export type EventResult =
    | ProjectTrustResult
    | ResourcesDiscoverResult
    | AgentsRegisterResult
    | ContextEventResult
    | BeforeAgentStartResult
    | ToolCallResult
    | ToolResultEventResult
    | InputEventResult
    | void
    | undefined

  export type Handler<E extends Event, R extends EventResult> = (event: E, ctx: Context) => R | Promise<R>

  export interface API {
    on<E extends Event>(event: E["type"], handler: Handler<E, EventResult>): void

    registerTool(tool: Tool.Info, source?: SourceInfo): void
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
  }

  export type Factory = (api: API) => void | Promise<void>

  export interface Loaded {
    path: string
    resolvedPath: string
    sourceInfo: SourceInfo
    factory: Factory
  }

  export interface Manifest {
    extensions?: string[]
  }
}
