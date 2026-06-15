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
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import z from "zod"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { ExtensionLoader } from "../extension/loader"
import { ExtensionRunner } from "../extension/runner"
import { ExtensionContext } from "../extension/context"
import type { Extension } from "../extension/types"
import { Entry } from "../entry/entry"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  export const ChangeEvent = "tool.registry.changed" as const

  export interface State {
    custom: Map<string, Tool.Info>
    runner: ExtensionRunner.State
  }

  export const state = Instance.state(async (): Promise<State> => {
    const custom = new Map<string, Tool.Info>()
    const glob = new Bun.Glob("tool/*.{js,ts}")

    for (const dir of await Config.directories()) {
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

    const contextFactory = (): Extension.Context =>
      ExtensionContext.create({
        mode: "rpc",
        cwd: Instance.directory,
        sessionID: "",
        agent: "",
        projectTrusted: true,
        getSystemPrompt: () => "",
      })

    const runner = ExtensionRunner.create(contextFactory)

    const extensions = await ExtensionLoader.load()
    for (const ext of extensions) {
      const api = createExtensionAPI(runner, ext.sourceInfo)
      try {
        await ext.factory(api)
      } catch (error) {
        log.error("extension factory failed", { path: ext.path, error })
      }
    }

    for (const [id, { tool, source }] of runner.tools) {
      custom.set(id, tool)
      log.info("registered extension tool", { id, source: source.scope })
    }

    const discoverCtx: Extension.Context = ExtensionContext.create({
      mode: "rpc",
      cwd: Instance.directory,
      sessionID: "",
      agent: "",
      projectTrusted: true,
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
  })

  export function createExtensionAPI(runner: ExtensionRunner.State, source: Extension.SourceInfo): Extension.API {
    return {
      on: (event, handler) => ExtensionRunner.on(runner, event, handler as any),
      registerTool: (tool) => ExtensionRunner.registerTool(runner, tool, source),
      unregisterTool: (id) => ExtensionRunner.unregisterTool(runner, id),
      setActiveTools: (toolNames) => ExtensionRunner.setActiveTools(runner, toolNames),
      getActiveTools: () => ExtensionRunner.getActiveTools(runner),
      getAllTools: () => ExtensionRunner.getAllTools(runner),
      registerCommand: (command) => ExtensionRunner.registerCommand(runner, command),
      unregisterCommand: (name) => ExtensionRunner.unregisterCommand(runner, name),
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: async (sessionID, customType, data) => {
        return Entry.append(sessionID, { type: "custom", customType, data })
      },
      appendCustomMessageEntry: async (sessionID, customType, content, display, details) => {
        return Entry.append(sessionID, {
          type: "custom_message",
          customType,
          content,
          display: display ?? true,
          details,
        })
      },
      setModel: async () => false,
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
    if (source) {
      runner.tools.set(tool.id, { tool, source })
    }
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

    return [
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
      ...(Flag.REDSUN_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      ...Array.from(custom.values()),
    ]
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

  function emitChanged() {
    // TODO: publish via Bus when event system is wired
  }
}
