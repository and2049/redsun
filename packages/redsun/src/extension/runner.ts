import { Log } from "../util/log"
import type { Tool } from "../tool/tool"
import type { Extension } from "./types"

export namespace ExtensionRunner {
  const log = Log.create({ service: "extension.runner" })

  export interface State {
    handlers: Map<string, Extension.Handler<Extension.Event, Extension.EventResult>[]>
    tools: Map<string, Extension.RegisteredTool>
    commands: Map<string, Extension.RegisteredCommand>
    activeTools: Set<string>
    contextFactory: () => Extension.Context
  }

  export function create(contextFactory: () => Extension.Context): State {
    return {
      handlers: new Map(),
      tools: new Map(),
      commands: new Map(),
      activeTools: new Set(),
      contextFactory,
    }
  }

  export function on<E extends Extension.Event>(
    state: State,
    event: E["type"],
    handler: Extension.Handler<E, Extension.EventResult>,
  ) {
    const list = state.handlers.get(event) ?? []
    list.push(handler as Extension.Handler<Extension.Event, Extension.EventResult>)
    state.handlers.set(event, list)
  }

  export function registerTool(state: State, tool: Tool.Info, source?: Extension.SourceInfo) {
    const id = tool.id
    log.info("registering tool", { id, source: source?.scope })
    state.tools.set(id, { tool, source: source ?? { path: "", scope: "builtin" } })
    if (state.activeTools.size === 0) {
      state.activeTools.add(id)
    }
  }

  export function unregisterTool(state: State, id: string) {
    state.tools.delete(id)
    state.activeTools.delete(id)
  }

  export function setActiveTools(state: State, toolNames: string[]) {
    state.activeTools = new Set(toolNames)
  }

  export function getActiveTools(state: State): string[] {
    return Array.from(state.activeTools)
  }

  export function getAllTools(state: State): Array<{ id: string; description: string; source: Extension.SourceInfo }> {
    return Array.from(state.tools.values()).map(({ tool, source }) => ({
      id: tool.id,
      description: "", // populated on init
      source,
    }))
  }

  export function registerCommand(state: State, command: Extension.RegisteredCommand) {
    state.commands.set(command.name, command)
  }

  export function unregisterCommand(state: State, name: string) {
    state.commands.delete(name)
  }

  export async function emit<E extends Extension.Event>(
    state: State,
    event: E,
    contextOverride?: Extension.Context,
  ): Promise<Extension.EventResult | undefined> {
    const handlers = state.handlers.get(event.type)
    if (!handlers || handlers.length === 0) return undefined

    const ctx = contextOverride ?? state.contextFactory()
    let result: Extension.EventResult | undefined

    for (const handler of handlers) {
      try {
        const r = await handler(event, ctx)
        if (r !== undefined) {
          result = mergeResults(result, r, event.type)
        }
      } catch (error) {
        log.error("extension handler failed", { event: event.type, error })
      }
    }

    return result
  }

  function mergeResults(
    current: Extension.EventResult | undefined,
    next: Extension.EventResult,
    eventType: string,
  ): Extension.EventResult {
    if (!current) return next

    if (eventType === "tool_call") {
      const c = current as Extension.ToolCallResult
      const n = next as Extension.ToolCallResult
      if (n.block) return { block: true, reason: n.reason }
      return c
    }

    if (eventType === "tool_result") {
      const c = current as Extension.ToolResultEventResult
      const n = next as Extension.ToolResultEventResult
      return {
        output: n.output ?? c.output,
        metadata: n.metadata ?? c.metadata,
        isError: n.isError ?? c.isError,
      }
    }

    if (eventType === "before_agent_start") {
      const c = current as Extension.BeforeAgentStartResult
      const n = next as Extension.BeforeAgentStartResult
      return { systemPrompt: n.systemPrompt ?? c.systemPrompt }
    }

    if (eventType === "context") {
      const n = next as Extension.ContextEventResult
      return { messages: n.messages }
    }

    return next
  }
}
