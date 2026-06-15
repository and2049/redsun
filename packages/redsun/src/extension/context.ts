import type { Extension } from "./types"
import { SessionStatus } from "../session/status"
import { Instance } from "../project/instance"

export namespace ExtensionContext {
  export function create(options: {
    mode: Extension.Mode
    cwd: string
    sessionID: string
    agent: string
    projectTrusted: boolean
    getSystemPrompt: () => string
    getEntries?: <T>(customType: string) => Array<{ customType: string; data?: T }>
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
      getContextUsage: () => undefined,
      getSystemPrompt: options.getSystemPrompt,
      getEntries: options.getEntries ?? (() => []),
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
      getEntries: <T>(customType: string) => listEntriesSync<T>(options.sessionID, customType),
    })
    return {
      ...base,
      isIdle: () => SessionStatus.get(options.sessionID).type === "idle",
      hasPendingMessages: () => false,
      reload: async () => {},
    }
  }

  function createUI(_mode: Extension.Mode): Extension.UIContext {
    return {
      notify: (message: string, _type?: "info" | "warning" | "error") => {},
      confirm: async () => false,
      input: async () => undefined,
      select: async () => undefined,
    }
  }

  function listEntriesSync<T>(_sessionID: string, _customType: string): Array<{ customType: string; data?: T }> {
    return []
  }
}
