import type { Extension } from "./types"
import { SessionStatus } from "../session/status"
import { Instance } from "../project/instance"
import { Entry } from "../entry/entry"
import { Log } from "../util/log"
import { ToolRegistry } from "../tool/registry"

export namespace ExtensionContext {
  export function create(options: {
    mode: Extension.Mode
    cwd: string
    sessionID: string
    agent: string
    projectTrusted: boolean
    getSystemPrompt: () => string
    getEntries?: <T>(customType: string) => Promise<Array<{ customType: string; data?: T; details?: T }>>
    signal?: AbortSignal
    abort?: () => void
  }): Extension.Context {
    const hasUI = options.mode === "tui" || options.mode === "rpc"

    return {
      ui: createUI(options.mode),
      mode: options.mode,
      hasUI,
      cwd: options.cwd,
      sessionID: options.sessionID,
      agent: options.agent,
      isIdle: () => true,
      isProjectTrusted: () => options.projectTrusted,
      signal: options.signal,
      abort: options.abort ?? (() => {}),
      hasPendingMessages: () => false,
      getContextUsage: () => {
        const status = SessionStatus.get(options.sessionID)
        if (status.contextUsage) return status.contextUsage
        return undefined
      },
      getSystemPrompt: options.getSystemPrompt,
      getEntries: options.getEntries ?? (async () => []),
      compact: async () => {
        if (!options.sessionID) return
        const sessionID = options.sessionID
        const agent = options.agent
        try {
          const { Session } = await import("../session/index")
          const messages = await Session.messages({ sessionID, limit: 10 })
          const lastUser = messages.findLast((m) => m.info.role === "user")
          let model: { providerID: string; modelID: string }
          if (lastUser?.info.role === "user" && lastUser.info.model) {
            model = lastUser.info.model
          } else {
            const { Provider } = await import("../provider/provider")
            const d = await Provider.defaultModel()
            model = { providerID: d?.providerID ?? "openai", modelID: d?.modelID ?? "gpt-4o" }
          }
          const { SessionCompaction } = await import("../session/compaction")
          await SessionCompaction.create({
            sessionID,
            agent,
            model,
            auto: false,
            fromExtension: true,
          })
        } catch (err) {
          Log.Default.error("compact() from extension context failed", { error: err })
          throw err
        }
      },
    }
  }

  export function forSession(options: {
    mode: Extension.Mode
    sessionID: string
    agent: string
    projectTrusted: boolean
    getSystemPrompt: () => string
    signal?: AbortSignal
    abort?: () => void
  }): Extension.CommandContext {
    const cwd = Instance.directory
    const base = create({
      mode: options.mode,
      cwd,
      sessionID: options.sessionID,
      agent: options.agent,
      projectTrusted: options.projectTrusted,
      getSystemPrompt: options.getSystemPrompt,
      signal: options.signal,
      abort: options.abort,
      getEntries: <T>(customType: string) => Entry.getByType<T>(options.sessionID, customType),
    })
    return {
      ...base,
      isIdle: () => SessionStatus.get(options.sessionID).type === "idle",
      hasPendingMessages: () => SessionStatus.get(options.sessionID).type === "busy",
      reload: async () => {
        await ToolRegistry.reload()
      },
      newSession: async (newOpts) => {
        const { Session } = await import("../session/index")
        const result = await Session.createNext({
          directory: Instance.directory,
          parentID: newOpts?.parentSession ?? options.sessionID,
          reason: "new",
        })
        return { sessionID: result.id }
      },
      fork: async (entryId: string) => {
        const { Session } = await import("../session/index")
        const result = await Session.createNext({
          directory: Instance.directory,
          parentID: entryId,
          reason: "fork",
        })
        return { sessionID: result.id }
      },
    }
  }

  function createUI(mode: Extension.Mode): Extension.UIContext {
    const log = Log.create({ service: "extension.ui" })
    return {
      notify: (message: string, type: "info" | "warning" | "error" = "info") => {
        log.info("notify", { message, type })
      },
      confirm: async (_title: string, _message: string) => {
        log.warn("confirm() is not yet wired to the TUI — always returns false")
        return false
      },
      input: async (_title: string, _placeholder?: string) => {
        log.warn("input() is not yet wired to the TUI — always returns undefined")
        return undefined
      },
      select: async (_title: string, _options: string[]) => {
        log.warn("select() is not yet wired to the TUI — always returns undefined")
        return undefined
      },
    }
  }
}
