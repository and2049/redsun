import type { Hooks, PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ProjectTrust } from "@/trust"
import type { Extension } from "./types"

type RegisteredTool = { definition: ToolDefinition; description: string; source: Extension.SourceInfo }
export type State = {
  directory: string
  trusted: boolean
  invalidated: boolean
  handlers: Map<string, Extension.Handler[]>
  tools: Map<string, RegisteredTool>
  commands: Map<string, Extension.RegisteredCommand>
  activeTools: Set<string>
  modelOverrides: Map<string, string>
  current?: Extension.Context
  eventBus: Map<string, Array<(data: unknown) => void>>
  providers: Map<string, Extension.ProviderConfig>
  plugin: PluginInput
  resources: { skillPaths: string[]; promptPaths: string[]; themePaths: string[]; agentPaths: string[] }
  turns: Map<string, number>
  statuses: Map<string, "busy" | "retry">
  systemPrompts: Map<string, string>
  extensionCompactions: Set<string>
  contextWindows: Map<string, number>
  contextUsage: Map<string, Extension.ContextUsage>
}

const states = new Map<string, State>()
export const stateFor = (directory: string) => states.get(path.resolve(directory))
export const activeToolIDs = (directory: string) => stateFor(directory)?.activeTools
export const commandFor = (directory: string, name: string) => stateFor(directory)?.commands.get(name)
export const commandsFor = (directory: string) => Array.from(stateFor(directory)?.commands.values() ?? [])
export const providersFor = (directory: string) => new Map(stateFor(directory)?.providers ?? [])
export const resourcesFor = (directory: string) => stateFor(directory)?.resources
export async function toolError(
  directory: string,
  input: { sessionID: string; callID?: string; tool: string; args: Record<string, unknown>; error: unknown },
) {
  const state = stateFor(directory)
  if (!state) return
  await emit(
    state,
    {
      type: "tool_result",
      toolCallId: input.callID ?? "",
      toolName: input.tool,
      input: input.args,
      output: input.error instanceof Error ? input.error.message : String(input.error),
      metadata: {},
      isError: true,
    },
    context(state, { sessionID: input.sessionID }),
  )
}
export async function customMessages(sessionID: string, maxChars = 24_000) {
  const stored = await readEntries(sessionID)
  const boundary = stored.findLastIndex((entry) => entry.customType === "extension.compaction-boundary")
  const entries = stored.slice(boundary + 1).filter((entry) => entry.customMessage && entry.content !== undefined)
  const result: string[] = []
  let total = 0
  let omitted = 0
  for (const entry of entries.reverse()) {
    const content = entry.content!
    const value = typeof content === "string" ? content : content.map((part) => part.text).join("\n")
    if (total >= maxChars) {
      omitted++
      continue
    }
    if (total + value.length > maxChars) {
      const marker = "[redsun: custom message truncated]"
      const remaining = Math.max(0, maxChars - total - marker.length - 1)
      result.unshift(`${remaining > 0 ? value.slice(-remaining) : ""}\n${marker}`)
      total = maxChars
      continue
    }
    result.unshift(value)
    total += value.length
  }
  if (omitted > 0) result.unshift(`[redsun: ${omitted} older custom message${omitted === 1 ? "" : "s"} omitted]`)
  return result
}
export async function runCommand(directory: string, name: string, args: string, sessionID: string, agent: string) {
  const state = stateFor(directory)
  const command = state?.commands.get(name)
  if (!state || !command) return false
  const base = context(state, { sessionID, agent })
  const previous = state.current
  state.current = base
  try {
    await command.handler(args, {
      ...base,
      reload: async () => {
        const { InstanceRuntime } = await import("@/project/instance-runtime")
        setTimeout(() => void InstanceRuntime.reloadInstance({ directory: state.plugin.directory }), 250)
      },
      newSession: async (options) => {
        const result = await state.plugin.client.session.create({ body: { parentID: options?.parentSession ?? sessionID } })
        const created = result.data?.id
        if (!created) throw new Error("Failed to create session")
        return { sessionID: created }
      },
      fork: async (entryId) => {
        const result = await state.plugin.client.session.fork({ path: { id: sessionID }, body: { messageID: entryId } })
        const forked = result.data?.id
        if (!forked) throw new Error("Failed to fork session")
        return { sessionID: forked }
      },
    })
  } finally {
    state.current = previous
  }
  return true
}

function context(state: State, input: { sessionID?: string; agent?: string; signal?: AbortSignal } = {}): Extension.Context {
  const sessionID = input.sessionID ?? ""
  return {
    mode: "rpc",
    hasUI: false,
    cwd: state.directory,
    sessionID,
    agent: input.agent ?? "",
    signal: input.signal,
    isProjectTrusted: () => state.trusted,
    getSystemPrompt: () => state.systemPrompts.get(sessionID) ?? "",
    abort: () => {
      if (!sessionID) return
      void state.plugin.client.session
        .abort({ path: { id: sessionID } })
        .then(undefined, (error) => console.error(`Failed to abort session ${sessionID}`, error))
    },
    isIdle: () => !state.statuses.has(sessionID),
    hasPendingMessages: () => state.statuses.get(sessionID) === "busy",
    getContextUsage: () => state.contextUsage.get(sessionID),
    getEntries: (customType) => readEntries(sessionID, customType),
    compact: async () => {
      if (!sessionID) return
      const result = await state.plugin.client.session.messages({ path: { id: sessionID }, query: { limit: 10 } })
      const info = result.data?.findLast((message) => message.info.role === "user")?.info
      if (!info || info.role !== "user") throw new Error(`Cannot compact session ${sessionID} without a user model`)
      state.extensionCompactions.add(sessionID)
      await state.plugin.client.session
        .summarize({
          path: { id: sessionID },
          body: { providerID: info.model.providerID, modelID: info.model.modelID },
        })
        .catch((error) => {
          state.extensionCompactions.delete(sessionID)
          throw error
        })
    },
    ui: {
      notify: (message, type = "info") => console[type === "warning" ? "warn" : type](message),
      confirm: async () => false,
      input: async () => undefined,
      select: async () => undefined,
    },
  }
}

async function emit<E extends Extension.Event>(state: State, event: E, ctx = context(state)) {
  if (state.invalidated) return
  const previous = state.current
  state.current = ctx
  let result: Extension.EventResult
  for (const handler of state.handlers.get(event.type) ?? []) {
    try {
      const next = await handler(event, ctx)
      if (next !== undefined) result = merge(result, next, event.type)
    } catch (error) {
      console.error(`redsun extension ${event.type} handler failed`, error)
    }
  }
  state.current = previous
  return result
}

function merge(current: Extension.EventResult, next: Extension.EventResult, type: string): Extension.EventResult {
  if (!current) return next
  if (type === "tool_call") {
    const value = next as { block?: boolean; reason?: string }
    return value.block ? value : current
  }
  if (type === "tool_result") return { ...(current as object), ...(next as object) }
  if (type === "project_trust") {
    const a = current as { trusted: "yes" | "no" | "undecided" }
    const b = next as typeof a
    return a.trusted === "undecided" ? b : a
  }
  if (type === "before_agent_start") {
    const a = current as { systemPrompt?: string }
    const b = next as typeof a
    return { systemPrompt: b.systemPrompt ?? a.systemPrompt }
  }
  if (type === "context") {
    const a = current as { messages?: unknown[] }
    const b = next as typeof a
    return { messages: b.messages ?? a.messages }
  }
  if (type === "session_before_compact") {
    const a = current as { context?: string[]; prompt?: string; cancel?: boolean }
    const b = next as typeof a
    return {
      prompt: b.prompt ?? a.prompt,
      cancel: a.cancel === true || b.cancel === true,
      context: [...(a.context ?? []), ...(b.context ?? [])],
    }
  }
  if (type === "resources_discover" || type === "agents_register") {
    const a = current as { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[]; agentPaths?: string[] }
    const b = next as typeof a
    return {
      skillPaths: [...new Set([...(a.skillPaths ?? []), ...(b.skillPaths ?? [])])],
      promptPaths: [...new Set([...(a.promptPaths ?? []), ...(b.promptPaths ?? [])])],
      themePaths: [...new Set([...(a.themePaths ?? []), ...(b.themePaths ?? [])])],
      agentPaths: [...new Set([...(a.agentPaths ?? []), ...(b.agentPaths ?? [])])],
    }
  }
  return next
}

const entryFile = (sessionID: string) => path.join(Global.Path.data, "extension-entry", `${sessionID}.json`)
type StoredEntry<T = unknown> = {
  customType: string
  data?: T
  details?: T
  content?: string | Array<{ type: "text"; text: string }>
  display?: boolean
  customMessage?: boolean
}
async function readEntries<T>(sessionID: string, customType?: string) {
  if (!sessionID) return []
  const entries = await readFile(entryFile(sessionID), "utf8").then(JSON.parse).catch(() => [])
  return (Array.isArray(entries) ? entries : []).filter((entry) => !customType || entry.customType === customType) as StoredEntry<T>[]
}
async function appendEntry(sessionID: string, entry: Record<string, unknown>) {
  const entries = await readEntries(sessionID)
  const id = `ext_${crypto.randomUUID()}`
  ;(entries as Array<Record<string, unknown>>).push({ id, ...entry })
  await mkdir(path.dirname(entryFile(sessionID)), { recursive: true })
  await writeFile(entryFile(sessionID), JSON.stringify(entries, null, 2))
  return id
}

function api(state: State, source: Extension.SourceInfo): Extension.API {
  const assertActive = () => {
    if (!state.invalidated) return
    throw new Error("This extension API is no longer valid because the runtime was reloaded")
  }
  return {
    on(event, handler) {
      assertActive()
      const list = state.handlers.get(event) ?? []
      list.push(handler as Extension.Handler)
      state.handlers.set(event, list)
    },
    async registerTool(tool, override) {
      assertActive()
      const resolved = await tool.init()
      assertActive()
      state.tools.set(tool.id, {
        description: resolved.description,
        source: override ?? source,
        definition: {
          description: resolved.description,
          args: resolved.parameters.shape,
          execute: (args, ctx) => Promise.resolve(resolved.execute(args, ctx)),
        },
      })
    },
    unregisterTool(id) {
      assertActive()
      state.tools.delete(id)
    },
    setActiveTools(ids) {
      assertActive()
      state.activeTools = new Set(ids)
    },
    getActiveTools() {
      assertActive()
      return Array.from(state.activeTools)
    },
    getAllTools() {
      assertActive()
      return Array.from(state.tools, ([id, item]) => ({ id, description: item.description, source: item.source }))
    },
    registerCommand(command) {
      assertActive()
      state.commands.set(command.name, command)
    },
    unregisterCommand(name) {
      assertActive()
      state.commands.delete(name)
    },
    sendMessage(content) {
      assertActive()
      const sessionID = state.current?.sessionID
      if (!sessionID) return
      const agent = state.current?.agent || "build"
      void appendEntry(sessionID, {
        customType: "extension.message",
        content,
        display: true,
        customMessage: true,
      })
        .then(() => {
          if (state.invalidated || state.statuses.has(sessionID)) return
          return state.plugin.client.session.promptAsync({
            path: { id: sessionID },
            body: {
              agent,
              parts: [{ type: "text", text: "Continue.", synthetic: true }],
            },
          })
        })
        .then(undefined, (error) => console.error(`Failed to send extension message to ${sessionID}`, error))
    },
    sendUserMessage(content) {
      assertActive()
      const sessionID = state.current?.sessionID
      if (!sessionID) return
      const agent = state.current?.agent || "build"
      void state.plugin.client.session
        .promptAsync({
          path: { id: sessionID },
          body: { agent, parts: [{ type: "text", text: content }] },
        })
        .then(undefined, (error) => console.error(`Failed to send extension user message to ${sessionID}`, error))
    },
    appendEntry(sessionID, customType, data) {
      assertActive()
      return appendEntry(sessionID, { customType, data })
    },
    appendCustomMessageEntry(sessionID, customType, content, display, details) {
      assertActive()
      return appendEntry(sessionID, { customType, content, display: display ?? true, details, customMessage: true })
    },
    async setModel(model) {
      assertActive()
      const sessionID = state.current?.sessionID
      if (!sessionID || !model.includes("/")) return false
      state.modelOverrides.set(sessionID, model)
      return true
    },
    registerProvider(name, config) {
      assertActive()
      state.providers.set(name, config)
    },
    unregisterProvider(name) {
      assertActive()
      state.providers.delete(name)
    },
    events: {
      emit(channel, data) {
        assertActive()
        for (const handler of state.eventBus.get(channel) ?? []) handler(data)
      },
      on(channel, handler) {
        assertActive()
        const list = state.eventBus.get(channel) ?? []
        list.push(handler)
        state.eventBus.set(channel, list)
        return () => state.eventBus.set(channel, (state.eventBus.get(channel) ?? []).filter((item) => item !== handler))
      },
    },
  }
}

async function loadFile(state: State, filepath: string, scope: Extension.SourceInfo["scope"]) {
  try {
    const resolved = path.resolve(filepath)
    const source = await readFile(resolved, "utf8")
    const mod = await import(`${pathToFileURL(resolved).href}?redsun=${Bun.hash(source)}`)
    const factory = mod.default ?? mod.extension
    if (typeof factory !== "function") return
    await factory(api(state, { path: resolved, scope }))
  } catch (error) {
    console.error(`Failed to load redsun extension ${filepath}`, error)
  }
}

async function discover(state: State, directory: string, scope: Extension.SourceInfo["scope"]) {
  if (!(await stat(directory).then((item) => item.isDirectory(), () => false))) return
  const glob = new Bun.Glob("*.{ts,js}")
  const files: string[] = []
  for await (const file of glob.scan({ cwd: directory, absolute: true, onlyFiles: true })) files.push(file)
  for (const file of files.sort()) await loadFile(state, file, scope)
}

async function loadEntry(state: State, entry: string, scope: Extension.SourceInfo["scope"]) {
  if (entry.startsWith("npm:")) {
    const mod = await import(entry.slice(4))
    const factory = mod.default ?? mod.extension
    if (typeof factory === "function") await factory(api(state, { path: entry, scope: "npm" }))
    return
  }
  await loadFile(state, entry.startsWith("file:") ? fileURLToPath(entry) : entry, scope)
}

export async function create(input: {
  plugin: PluginInput
  userEntries: string[]
  projectEntries: string[]
  defaultTrust?: "ask" | "always" | "never"
}) {
  const directory = path.resolve(input.plugin.directory)
  const previous = states.get(directory)
  if (previous) previous.invalidated = true
  const state: State = {
    directory,
    trusted: false,
    invalidated: false,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    activeTools: new Set(),
    modelOverrides: new Map(),
    eventBus: new Map(),
    providers: new Map(),
    plugin: input.plugin,
    resources: { skillPaths: [], promptPaths: [], themePaths: [], agentPaths: [] },
    turns: new Map(),
    statuses: new Map(),
    systemPrompts: new Map(),
    extensionCompactions: new Set(),
    contextWindows: new Map(),
    contextUsage: new Map(),
  }
  states.set(directory, state)

  for (const entry of input.userEntries) await loadEntry(state, entry, "user")
  await discover(state, path.join(Global.Path.config, "extensions"), "user")
  await discover(state, path.join(Global.Path.home, ".redsun", "extensions"), "user")

  const vote = (await emit(state, { type: "project_trust", cwd: directory }, context(state))) as
    | { trusted: "yes" | "no" | "undecided"; remember?: boolean }
    | undefined
  const stored = ProjectTrust.get(directory)
  state.trusted = vote?.trusted === "yes" || (vote?.trusted !== "no" && (stored ?? input.defaultTrust === "always"))
  if (vote?.trusted === "yes" || vote?.trusted === "no") ProjectTrust.setSession(directory, vote.trusted === "yes")
  if (vote?.remember && vote.trusted !== "undecided") ProjectTrust.set(directory, vote.trusted === "yes")

  if (state.trusted) {
    for (const entry of input.projectEntries) await loadEntry(state, entry, "project")
    await discover(state, path.join(directory, ".redsun", "extensions"), "project")
  }
  for (const result of [
    await emit(state, { type: "resources_discover", cwd: directory, reason: "startup" }),
    await emit(state, { type: "agents_register", cwd: directory, reason: "startup" }),
  ]) {
    if (!result || typeof result !== "object") continue
    for (const key of ["skillPaths", "promptPaths", "themePaths", "agentPaths"] as const) {
      const values = (result as Record<string, unknown>)[key]
      if (Array.isArray(values)) {
        state.resources[key] = [
          ...new Set([...state.resources[key], ...values.filter((item): item is string => typeof item === "string")]),
        ]
      }
    }
  }
  await emit(state, { type: "session_start", reason: "startup" })

  const hooks: Hooks = {
    tool: Object.fromEntries(Array.from(state.tools, ([id, item]) => [id, item.definition])),
    async "tool.execute.before"(input, output) {
      const result = (await emit(
        state,
        { type: "tool_call", toolCallId: input.callID, toolName: input.tool, input: output.args },
        context(state, { sessionID: input.sessionID }),
      )) as { block?: boolean; reason?: string } | undefined
      if (result?.block) throw new Error(result.reason ?? "blocked by extension")
    },
    async "tool.execute.after"(input, output) {
      if (!output) return
      const result = (await emit(
        state,
        {
          type: "tool_result",
          toolCallId: input.callID,
          toolName: input.tool,
          input: input.args,
          output: output.output,
          metadata: output.metadata ?? {},
          isError: (output as typeof output & { isError?: boolean }).isError === true,
        },
        context(state, { sessionID: input.sessionID }),
      )) as { output?: string; metadata?: Record<string, unknown> } | undefined
      if (result?.output !== undefined) output.output = result.output
      if (result?.metadata !== undefined) output.metadata = result.metadata
    },
    async "chat.message"(input, output) {
      const ctx = context(state, { sessionID: input.sessionID, agent: input.agent })
      const text = output.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      const result = (await emit(state, { type: "input", text }, ctx)) as { action?: string; text?: string } | undefined
      if (result?.action === "transform" && result.text !== undefined) {
        const part = output.parts.find((item) => item.type === "text")
        if (part?.type === "text") part.text = result.text
      }
      const model = state.modelOverrides.get(input.sessionID)
      if (model) {
        const [providerID, ...rest] = model.split("/")
        if (providerID && rest.length) output.message.model = { providerID, modelID: rest.join("/") }
        state.modelOverrides.delete(input.sessionID)
      }
    },
    async "experimental.chat.system.transform"(input, output) {
      if (input.sessionID) {
        const turnIndex = (state.turns.get(input.sessionID) ?? 0) + 1
        state.turns.set(input.sessionID, turnIndex)
        state.contextWindows.set(input.sessionID, input.model.limit.context)
        state.systemPrompts.set(input.sessionID, output.system.join("\n"))
        await emit(state, { type: "turn_start", turnIndex }, context(state, { sessionID: input.sessionID }))
      }
      const current = output.system.join("\n")
      const result = (await emit(
        state,
        { type: "before_agent_start", prompt: "", systemPrompt: current },
        context(state, { sessionID: input.sessionID }),
      )) as { systemPrompt?: string } | undefined
      if (result?.systemPrompt !== undefined) output.system = [result.systemPrompt]
      if (input.sessionID) state.systemPrompts.set(input.sessionID, output.system.join("\n"))
    },
    async "experimental.chat.messages.transform"(_input, output) {
      const sessionID = output.messages.findLast((message) => "sessionID" in message.info)?.info.sessionID
      const custom = sessionID ? await customMessages(sessionID) : []
      const target = output.messages.findLast((message) => message.info.role === "user")
      const part = target?.parts.findLast((item) => item.type === "text")
      if (part?.type === "text" && custom.length) {
        part.text += `\n\n<extension-context>\n${custom.join("\n\n")}\n</extension-context>`
      }
      const result = (await emit(state, { type: "context", messages: output.messages })) as
        | { messages?: typeof output.messages }
        | undefined
      if (result?.messages) output.messages = result.messages
    },
    async "experimental.session.compacting"(input, output) {
      const result = (await emit(
        state,
        { type: "session_before_compact", sessionID: input.sessionID, signal: new AbortController().signal },
        context(state, { sessionID: input.sessionID }),
      )) as { context?: string[]; prompt?: string } | undefined
      if (result?.context) output.context.push(...result.context)
      if (result?.prompt) output.prompt = result.prompt
    },
    async event({ event }) {
      if (event.type === "message.updated") {
        const info = event.properties.info
        if (info.role === "assistant") {
          const contextWindow = state.contextWindows.get(info.sessionID)
          if (contextWindow !== undefined) {
            const tokens = info.tokens.input + info.tokens.output + info.tokens.reasoning
            state.contextUsage.set(info.sessionID, {
              tokens,
              contextWindow,
              percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
            })
          }
        }
      }
      if (event.type === "session.status") {
        const properties = event.properties as { sessionID: string; status: { type: "idle" | "busy" | "retry" } }
        if (properties.status.type === "idle") state.statuses.delete(properties.sessionID)
        else state.statuses.set(properties.sessionID, properties.status.type)
      }
      if (event.type === "session.idle") {
        const properties = event.properties as { sessionID?: string }
        state.statuses.delete(properties.sessionID ?? "")
        const turnIndex = state.turns.get(properties.sessionID ?? "") ?? 0
        await emit(state, { type: "turn_end", turnIndex }, context(state, { sessionID: properties.sessionID }))
      }
      if (event.type === "session.compacted") {
        const properties = event.properties as { sessionID: string }
        await appendEntry(properties.sessionID, { customType: "extension.compaction-boundary" })
        await emit(
          state,
          {
            type: "session_compact",
            sessionID: properties.sessionID,
            fromExtension: state.extensionCompactions.delete(properties.sessionID),
          },
          context(state, { sessionID: properties.sessionID }),
        )
      }
    },
    async dispose() {
      await emit(state, { type: "session_shutdown", reason: "quit" })
      state.invalidated = true
      if (states.get(directory) === state) states.delete(directory)
    },
  }
  return { hooks, trusted: state.trusted }
}

export * as ExtensionRuntime from "./runtime"
