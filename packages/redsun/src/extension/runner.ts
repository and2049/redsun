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
    discoveredResources: { skillPaths: string[]; promptPaths: string[]; agentPaths: string[]; themePaths: string[] }
    projectTrusted: boolean
    pendingProviderRegistrations: Array<{ name: string; config: Extension.ProviderConfig; source: string }>
    registeredProviders: Map<string, { config: Extension.ProviderConfig; source: string }>
    providerRegistrar?: {
      register: (name: string, config: Extension.ProviderConfig) => void | Promise<void>
      unregister: (name: string) => void | Promise<void>
    }
    eventBus: Map<string, Array<(data: unknown) => void>>
    currentContext?: Extension.Context
    invalidated?: boolean
  }

  export function create(contextFactory: () => Extension.Context): State {
    return {
      handlers: new Map(),
      tools: new Map(),
      commands: new Map(),
      activeTools: new Set(),
      contextFactory,
      discoveredResources: { skillPaths: [], promptPaths: [], agentPaths: [], themePaths: [] },
      projectTrusted: false,
      pendingProviderRegistrations: [],
      registeredProviders: new Map(),
      eventBus: new Map(),
    }
  }

  export function invalidate(state: State) {
    state.invalidated = true
  }

  export function isInvalidated(state: State): boolean {
    return state.invalidated === true
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

  export async function registerTool(state: State, tool: Tool.Info, source?: Extension.SourceInfo) {
    const id = tool.id
    log.info("registering tool", { id, source: source?.scope })
    let description: string | undefined
    try {
      const initialized = await tool.init()
      description = initialized.description
    } catch (error) {
      log.warn("failed to initialize tool for description", { id, error })
    }
    state.tools.set(id, { tool, source: source ?? { path: "", scope: "builtin" }, description })
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

  export function isToolActive(state: State, id: string) {
    return state.activeTools.size === 0 || state.activeTools.has(id)
  }

  export function getAllTools(state: State): Array<{ id: string; description: string; source: Extension.SourceInfo }> {
    return Array.from(state.tools.values()).map(({ tool, source, description }) => ({
      id: tool.id,
      description: description ?? "",
      source,
    }))
  }

  export function registerCommand(state: State, command: Extension.RegisteredCommand) {
    state.commands.set(command.name, command)
  }

  export function unregisterCommand(state: State, name: string) {
    state.commands.delete(name)
  }

  export function registerProvider(state: State, name: string, config: Extension.ProviderConfig, source: string) {
    state.registeredProviders.set(name, { config, source })
    if (state.providerRegistrar) {
      void Promise.resolve(state.providerRegistrar.register(name, config)).catch((error) => {
        log.error("provider registration failed", { name, error })
      })
    } else {
      const index = state.pendingProviderRegistrations.findIndex((entry) => entry.name === name)
      const registration = { name, config, source }
      if (index === -1) state.pendingProviderRegistrations.push(registration)
      else state.pendingProviderRegistrations[index] = registration
    }
  }

  export function unregisterProvider(state: State, name: string) {
    state.registeredProviders.delete(name)
    if (state.providerRegistrar) {
      void Promise.resolve(state.providerRegistrar.unregister(name)).catch((error) => {
        log.error("provider unregistration failed", { name, error })
      })
    } else {
      state.pendingProviderRegistrations = state.pendingProviderRegistrations.filter((r) => r.name !== name)
    }
  }

  export async function flushProviderRegistrations(state: State) {
    if (!state.providerRegistrar) return
    const pending = state.pendingProviderRegistrations
    state.pendingProviderRegistrations = []
    for (const { name, config } of pending) {
      try {
        await state.providerRegistrar.register(name, config)
      } catch (error) {
        log.error("provider registration failed", { name, error })
      }
    }
  }

  export async function unregisterAllProviders(state: State) {
    const names = Array.from(state.registeredProviders.keys())
    state.registeredProviders.clear()
    state.pendingProviderRegistrations = []
    if (!state.providerRegistrar) return
    await Promise.all(
      names.map(async (name) => {
        try {
          await state.providerRegistrar!.unregister(name)
        } catch (error) {
          log.error("provider unregistration failed", { name, error })
        }
      }),
    )
  }

  export function emitEvent(state: State, channel: string, data: unknown) {
    const handlers = state.eventBus.get(channel)
    if (!handlers || handlers.length === 0) return
    for (const handler of handlers) {
      try {
        handler(data)
      } catch (error) {
        log.error("extension event bus handler failed", { channel, error })
      }
    }
  }

  export function onEvent(state: State, channel: string, handler: (data: unknown) => void): () => void {
    const existing = state.eventBus.get(channel) ?? []
    existing.push(handler)
    state.eventBus.set(channel, existing)
    return () => {
      const updated = (state.eventBus.get(channel) ?? []).filter((h) => h !== handler)
      if (updated.length === 0) {
        state.eventBus.delete(channel)
      } else {
        state.eventBus.set(channel, updated)
      }
    }
  }

  export async function emitProjectTrust(
    state: State,
    event: Extension.ProjectTrustEvent,
    ctx: Extension.ProjectTrustContext,
  ): Promise<Extension.ProjectTrustResult | undefined> {
    const handlers = state.handlers.get("project_trust")
    if (!handlers || handlers.length === 0) return undefined

    for (const handler of handlers) {
      try {
        const result = (await handler(event, ctx as any)) as Extension.ProjectTrustResult | undefined
        if (result && result.trusted !== "undecided") {
          return result
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error("project_trust handler failed", { error: message })
      }
    }

    return undefined
  }

  export async function emit<E extends Extension.Event>(
    state: State,
    event: E,
    contextOverride?: Extension.Context,
  ): Promise<Extension.EventResult | undefined> {
    if (isInvalidated(state)) {
      log.warn("emit called on invalidated runner", { event: event.type })
      return undefined
    }
    const handlers = state.handlers.get(event.type)
    if (!handlers || handlers.length === 0) return undefined

    const ctx = contextOverride ?? state.contextFactory()
    const previous = state.currentContext
    state.currentContext = ctx
    let result: Extension.EventResult | undefined

    for (const handler of handlers) {
      try {
        const r = await handler(event, ctx)
        if (r !== undefined) {
          result = mergeResults(result, r, event.type)
          if (event.type === "resources_discover" || event.type === "agents_register") {
            applyDiscoveredResources(state, r)
          }
        }
      } catch (error) {
        log.error("extension handler failed", { event: event.type, error })
      }
    }

    state.currentContext = previous
    return result
  }

  function applyDiscoveredResources(
    state: State,
    result: Extension.EventResult,
  ) {
    const r = result as Extension.ResourcesDiscoverResult & Extension.AgentsRegisterResult
    if (!r) return
    if (r.skillPaths) {
      for (const p of r.skillPaths) {
        if (!state.discoveredResources.skillPaths.includes(p)) {
          state.discoveredResources.skillPaths.push(p)
        }
      }
    }
    if (r.promptPaths) {
      for (const p of r.promptPaths) {
        if (!state.discoveredResources.promptPaths.includes(p)) {
          state.discoveredResources.promptPaths.push(p)
        }
      }
    }
    if (r.agentPaths) {
      for (const p of r.agentPaths) {
        if (!state.discoveredResources.agentPaths.includes(p)) {
          state.discoveredResources.agentPaths.push(p)
        }
      }
    }
    if (r.themePaths) {
      for (const p of r.themePaths) {
        if (!state.discoveredResources.themePaths.includes(p)) {
          state.discoveredResources.themePaths.push(p)
        }
      }
    }
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

    if (eventType === "resources_discover") {
      const c = current as Extension.ResourcesDiscoverResult
      const n = next as Extension.ResourcesDiscoverResult
      return {
        skillPaths: [...(c.skillPaths ?? []), ...(n.skillPaths ?? [])],
        promptPaths: [...(c.promptPaths ?? []), ...(n.promptPaths ?? [])],
        themePaths: [...(c.themePaths ?? []), ...(n.themePaths ?? [])],
      }
    }

    if (eventType === "agents_register") {
      const c = current as Extension.AgentsRegisterResult
      const n = next as Extension.AgentsRegisterResult
      return {
        agentPaths: [...(c.agentPaths ?? []), ...(n.agentPaths ?? [])],
      }
    }

    if (eventType === "session_before_compact") {
      const c = current as Extension.SessionBeforeCompactResult
      const n = next as Extension.SessionBeforeCompactResult
      if (n.cancel) return { cancel: true }
      return {
        prompt: n.prompt ?? c.prompt,
        context: [...(c.context ?? []), ...(n.context ?? [])],
      }
    }

    if (eventType === "session_before_switch") {
      const n = next as Extension.SessionBeforeSwitchResult
      if (n.cancel) return { cancel: true }
      return current
    }

    if (eventType === "session_before_fork") {
      const n = next as Extension.SessionBeforeForkResult
      if (n.cancel) return { cancel: true }
      return current
    }

    return next
  }
}
