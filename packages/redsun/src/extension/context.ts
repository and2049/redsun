import type { Extension } from "./types"
import { SessionStatus } from "../session/status"
import { Instance } from "../project/instance"
import { Entry } from "../entry/entry"
import { Log } from "../util/log"

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
      hasPendingMessages: () => false,
      reload: async () => {
        await Instance.dispose()
      },
    }
  }

  function createUI(mode: Extension.Mode): Extension.UIContext {
    const log = Log.create({ service: "extension.ui" })
    return {
      notify: (message: string, type: "info" | "warning" | "error" = "info") => {
        log.info("notify", { message, type })
      },
      confirm: async (title: string, message: string) => {
        log.warn("confirm() is not available in this mode", { mode, title, message })
        return false
      },
      input: async (title: string, placeholder?: string) => {
        log.warn("input() is not available in this mode", { mode, title, placeholder })
        return undefined
      },
      select: async (title: string, options: string[]) => {
        log.warn("select() is not available in this mode", { mode, title, options })
        return undefined
      },
    }
  }
}
