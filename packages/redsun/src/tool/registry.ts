import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ListTool } from "./ls"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { ReloadTool } from "./reload"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { State } from "../project/state"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import path from "path"
import z from "zod"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { ProjectTool } from "./project"
import { ExtensionLoader } from "../extension/loader"
import { ExtensionRunner } from "../extension/runner"
import { ExtensionContext } from "../extension/context"
import type { Extension } from "../extension/types"
import { Entry } from "../entry/entry"
import { iife } from "@/util/iife"

let trustOverride: boolean | undefined

const sessionModelOverrides = new Map<string, { providerID: string; modelID: string }>()

export namespace TrustFlag {
  export function set(trusted: boolean) {
    trustOverride = trusted
  }
  export function get() {
    return trustOverride
  }
  export function clear() {
    trustOverride = undefined
  }
}

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  export const ChangeEvent = BusEvent.define(
    "tool.registry.changed",
    z.object({
      directory: z.string(),
    }),
  )

  export interface State {
    custom: Map<string, Tool.Info>
    runner: ExtensionRunner.State
  }

  async function initState(): Promise<State> {
    const custom = new Map<string, Tool.Info>()
    const glob = new Bun.Glob("tool/*.{js,ts}")

    async function loadCustomTools(scope: Config.SourceScope) {
      for (const dir of await Config.executableDirectories(scope)) {
        for await (const match of glob.scan({
          cwd: dir,
          absolute: true,
          followSymlinks: true,
          dot: true,
        })) {
          const namespace = path.basename(match, path.extname(match))
          const mod = await import(match)
          for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
            const tool = fromLegacyDefinition(id === "default" ? namespace : `${namespace}_${id}`, def)
            custom.set(tool.id, tool)
          }
        }
      }
    }

    await loadCustomTools("user")

    let runner: ExtensionRunner.State
    const contextFactory = (): Extension.Context =>
      ExtensionContext.create({
        mode: "rpc",
        cwd: Instance.directory,
        sessionID: "",
        agent: "",
        projectTrusted: runner?.projectTrusted ?? false,
        getSystemPrompt: () => "",
      })

    runner = ExtensionRunner.create(contextFactory)

    // Phase 1: Load non-project extensions first (config, CLI, global)
    const nonProjectExtensions = await ExtensionLoader.load({ projectTrusted: false })
    for (const ext of nonProjectExtensions) {
      const api = createExtensionAPI(runner, ext.sourceInfo)
      try {
        await ext.factory(api)
      } catch (error) {
        log.error("extension factory failed", { path: ext.path, error })
      }
    }

    // Phase 2: Resolve project trust, allowing non-project extensions to vote
    const { resolveProjectTrusted } = await import("../trust/project-trust")
    const { createTrustStore } = await import("../trust/manager")
    const trustStore = createTrustStore()
    const defaultTrust = await Config.userDefaultProjectTrust()
    const trustCtx = ExtensionContext.create({
      mode: "rpc",
      cwd: Instance.directory,
      sessionID: "",
      agent: "",
      projectTrusted: false,
      getSystemPrompt: () => "",
    })
    const trusted = await resolveProjectTrusted({
      cwd: Instance.directory,
      trustStore,
      trustOverride: iife((): boolean | undefined => {
        if (trustOverride !== undefined) return trustOverride
        if (defaultTrust === "always") return true
        if (defaultTrust === "never") return false
        return undefined
      }),
      defaultProjectTrust: defaultTrust as "ask" | "always" | "never" | undefined,
      runner,
      mode: "rpc",
      hasUI: false,
      ui: trustCtx.ui,
    })
    runner.projectTrusted = trusted

    // Phase 3: Load project extensions if trusted
    if (trusted) {
      const projectExtensions = await ExtensionLoader.loadProjectExtensions(
        new Set(nonProjectExtensions.map((extension) => extension.resolvedPath)),
      )
      for (const ext of projectExtensions) {
        const api = createExtensionAPI(runner, ext.sourceInfo)
        try {
          await ext.factory(api)
        } catch (error) {
          log.error("extension factory failed", { path: ext.path, error })
        }
      }
      await loadCustomTools("project")
    }

    // Phase 4: Discover tools from all loaded extensions
    for (const [id, { tool, source }] of runner.tools) {
      custom.set(id, tool)
      log.info("registered extension tool", { id, source: source.scope })
    }

    // Wire provider registrar and flush pending registrations
    const { Provider } = await import("../provider/provider")
    runner.providerRegistrar = {
      register: (name, config) => Provider.registerProvider(name, config),
      unregister: (name) => Provider.unregisterProvider(name),
    }
    await ExtensionRunner.flushProviderRegistrations(runner)

    const discoverCtx: Extension.Context = ExtensionContext.create({
      mode: "rpc",
      cwd: Instance.directory,
      sessionID: "",
      agent: "",
      projectTrusted: trusted,
      getSystemPrompt: () => "",
    })
    await ExtensionRunner.emit<Extension.ResourcesDiscoverEvent>(
      runner,
      { type: "resources_discover", cwd: Instance.directory, reason: "startup" },
      discoverCtx,
    )
    await ExtensionRunner.emit<Extension.AgentsRegisterEvent>(
      runner,
      { type: "agents_register", cwd: Instance.directory, reason: "startup" },
      discoverCtx,
    )

    return { custom, runner }
  }

  export const state = Instance.state(initState)

  let pendingReload = false

  export function setPendingReload() {
    pendingReload = true
  }

  export function consumePendingReload(): boolean {
    if (pendingReload) {
      pendingReload = false
      return true
    }
    return false
  }

  export async function reload() {
    const s = await state()
    const oldRunner = s.runner

    const [{ SessionStatus }, { ExtensionContext: EC }] = await Promise.all([
      import("../session/status"),
      import("../extension/context"),
    ])
    const statuses = SessionStatus.list()
    for (const [sessionID, status] of Object.entries(statuses)) {
      if (status.type === "idle") continue
      const ctx = EC.forSession({
        mode: "rpc",
        sessionID,
        agent: "",
        projectTrusted: oldRunner.projectTrusted,
        getSystemPrompt: () => "",
      })
      await ExtensionRunner.emit(oldRunner, { type: "session_shutdown", reason: "reload" }, ctx)
    }

    await ExtensionRunner.unregisterAllProviders(oldRunner)
    sessionModelOverrides.clear()
    ExtensionRunner.invalidate(oldRunner)

    State.reset(Instance.directory, initState as () => unknown)
    await state()

    const newState = await state()
    const newRunner = newState.runner

    const discoverCtx: Extension.Context = ExtensionContext.create({
      mode: "rpc",
      cwd: Instance.directory,
      sessionID: "",
      agent: "",
      projectTrusted: newRunner.projectTrusted,
      getSystemPrompt: () => "",
    })
    await ExtensionRunner.emit<Extension.ResourcesDiscoverEvent>(
      newRunner,
      { type: "resources_discover", cwd: Instance.directory, reason: "reload" },
      discoverCtx,
    )

    const [{ Skill }, { PromptTemplate }, { Command }] = await Promise.all([
      import("../skill/skill"),
      import("../prompt/template"),
      import("../command"),
    ])
    Skill.invalidate()
    PromptTemplate.invalidate()
    Command.invalidate()

    for (const [sessionID, status] of Object.entries(statuses)) {
      if (status.type === "idle") continue
      const ctx = EC.forSession({
        mode: "rpc",
        sessionID,
        agent: "",
        projectTrusted: newRunner.projectTrusted,
        getSystemPrompt: () => "",
      })
      await ExtensionRunner.emit(newRunner, { type: "session_start", reason: "reload" }, ctx)
    }

    log.info("reload completed")
    emitChanged()
  }

  export function createExtensionAPI(runner: ExtensionRunner.State, source: Extension.SourceInfo): Extension.API {
    const assertActive = () => {
      if (ExtensionRunner.isInvalidated(runner)) {
        throw new Error(
          "This extension context is no longer valid. The runtime was reloaded — " +
          "the extension factory will be called again with a fresh API object. " +
          "Discard any captured references to the old api or ctx."
        )
      }
    }
    return {
      on: (event, handler) => { assertActive(); ExtensionRunner.on(runner, event, handler as any) },
      registerTool: async (tool) => {
        assertActive()
        await ExtensionRunner.registerTool(runner, tool, source)
        const s = await state()
        s.custom.set(tool.id, tool)
        emitChanged()
      },
      unregisterTool: (id) => {
        assertActive()
        ExtensionRunner.unregisterTool(runner, id)
        state().then((s) => {
          s.custom.delete(id)
          emitChanged()
        })
      },
      setActiveTools: (toolNames) => { assertActive(); ExtensionRunner.setActiveTools(runner, toolNames) },
      getActiveTools: () => { assertActive(); return ExtensionRunner.getActiveTools(runner) },
      getAllTools: () => { assertActive(); return ExtensionRunner.getAllTools(runner) },
      registerCommand: (command) => { assertActive(); ExtensionRunner.registerCommand(runner, command) },
      unregisterCommand: (name) => { assertActive(); ExtensionRunner.unregisterCommand(runner, name) },
      sendMessage: (content: string) => {
        assertActive()
        const sessionID = runner.currentContext?.sessionID
        if (!sessionID) {
          log.warn("sendMessage called outside session context", { content })
          return
        }
        Entry.append(sessionID, {
          type: "custom_message",
          customType: "extension.message",
          content,
          display: true,
        }).then(async () => {
          log.info("sendMessage delivered", { sessionID })
          const { SessionStatus } = await import("../session/status")
          if (SessionStatus.get(sessionID).type === "idle") {
            import("../session/prompt").then(({ SessionPrompt }) => {
              SessionPrompt.loop(sessionID)
            }).catch((err) => {
              log.error("sendMessage loop trigger failed", { sessionID, error: err })
            })
          }
        }).catch((err) => {
          log.error("sendMessage failed", { sessionID, error: err })
        })
      },
      sendUserMessage: (content: string) => {
        assertActive()
        const sessionID = runner.currentContext?.sessionID
        if (!sessionID) {
          log.warn("sendUserMessage called outside session context", { content })
          return
        }
        import("../session/prompt").then(({ SessionPrompt }) => {
          SessionPrompt.sendUserMessage(sessionID, content)
        }).catch((err) => {
          log.error("sendUserMessage failed", { sessionID, error: err })
        })
      },
      appendEntry: async (sessionID, customType, data) => {
        assertActive()
        return Entry.append(sessionID, { type: "custom", customType, data })
      },
      appendCustomMessageEntry: async (sessionID, customType, content, display, details) => {
        assertActive()
        return Entry.append(sessionID, {
          type: "custom_message",
          customType,
          content,
          display: display ?? true,
          details,
        })
      },
      setModel: async (model: string) => {
        assertActive()
        const sessionID = runner.currentContext?.sessionID
        if (!sessionID) {
          log.warn("setModel called outside session context", { model })
          return false
        }
        try {
          const { Provider } = await import("../provider/provider")
          const parsed = Provider.parseModel(model)
          await Provider.getModel(parsed.providerID, parsed.modelID)
          sessionModelOverrides.set(sessionID, { providerID: parsed.providerID, modelID: parsed.modelID })
          log.info("setModel", { model, sessionID })
          return true
        } catch (error) {
          log.warn("setModel failed", { model, error })
          return false
        }
      },
      registerProvider: (name, config) => { assertActive(); ExtensionRunner.registerProvider(runner, name, config, source.path) },
      unregisterProvider: (name) => { assertActive(); ExtensionRunner.unregisterProvider(runner, name) },
      events: {
        emit: (channel: string, data: unknown) => { assertActive(); ExtensionRunner.emitEvent(runner, channel, data) },
        on: (channel: string, handler: (data: unknown) => void) => { assertActive(); return ExtensionRunner.onEvent(runner, channel, handler) },
      },
    }
  }

  export interface ToolDefinition {
    description: string
    args: Record<string, z.ZodType>
    execute(args: Record<string, unknown>, ctx: Tool.Context): Promise<string>
  }

  function fromLegacyDefinition(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async () => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const result = await def.execute(args as any, ctx)
          return {
            title: "",
            output: result,
            metadata: {},
          }
        },
      }),
    }
  }

  export async function register(tool: Tool.Info, source?: Extension.SourceInfo) {
    const { custom, runner } = await state()
    custom.set(tool.id, tool)
    await ExtensionRunner.registerTool(runner, tool, source)
    emitChanged()
  }

  export async function unregister(id: string) {
    const { custom, runner } = await state()
    custom.delete(id)
    runner.tools.delete(id)
    runner.activeTools.delete(id)
    emitChanged()
  }

  export async function get(id: string): Promise<Tool.Info | undefined> {
    const tools = await allTools()
    return tools.find((t) => t.id === id)
  }

  export async function all(): Promise<Tool.Info[]> {
    return allTools()
  }

  export async function ids() {
    return allTools().then((x) => x.map((t) => t.id))
  }

  async function allTools(): Promise<Tool.Info[]> {
    const { custom } = await state()
    const config = await Config.get()
    const customIds = new Set(Array.from(custom.keys()))

    const builtins: Tool.Info[] = [
      InvalidTool,
      BashTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      TaskTool,
      WebFetchTool,
      TodoWriteTool,
      TodoReadTool,
      WebSearchTool,
      CodeSearchTool,
      SkillTool,
      ReloadTool,
      ProjectTool,
      ...(Flag.REDSUN_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
    ]

    const customTools = Array.from(custom.values()).sort((a, b) => a.id.localeCompare(b.id))
    return [...builtins.filter((t) => !customIds.has(t.id)), ...customTools]
  }

  export async function tools(providerID: string, agent?: Agent.Info) {
    const tools = await allTools()
    const result = await Promise.all(
      tools
        .filter((t) => {
          if (t.id === "codesearch" || t.id === "websearch") {
            return Flag.REDSUN_ENABLE_EXA
          }
          return true
        })
        .map(async (t) => {
          using _ = log.time(t.id)
          return {
            id: t.id,
            ...(await t.init({ agent })),
          }
        }),
    )
    return result
  }

  export async function enabled(agent: Agent.Info): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {}

    if (agent.permission.edit === "deny") {
      result["edit"] = false
      result["write"] = false
    }
    if (agent.permission.bash["*"] === "deny" && Object.keys(agent.permission.bash).length === 1) {
      result["bash"] = false
    }
    if (agent.permission.webfetch === "deny") {
      result["webfetch"] = false
      result["codesearch"] = false
      result["websearch"] = false
    }
    if (agent.permission.skill["*"] === "deny" && Object.keys(agent.permission.skill).length === 1) {
      result["skill"] = false
    }

    return result
  }

  export async function getRunner(): Promise<ExtensionRunner.State> {
    return state().then((s) => s.runner)
  }

  export function consumeModelOverride(sessionID: string): { providerID: string; modelID: string } | undefined {
    const model = sessionModelOverrides.get(sessionID)
    if (model) {
      sessionModelOverrides.delete(sessionID)
      return model
    }
    return undefined
  }

  function emitChanged() {
    Bus.publish(ChangeEvent, {
      directory: Instance.directory,
    })
  }
}
