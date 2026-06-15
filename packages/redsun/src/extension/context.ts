import type { Extension } from "./types"

export namespace ExtensionContext {
  export function create(options: {
    mode: Extension.Mode
    cwd: string
    sessionID: string
    agent: string
    projectTrusted: boolean
    getSystemPrompt: () => string
    getEntries?: <T>(customType: string) => Array<{ customType: string; data?: T }>
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
      signal: undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      getSystemPrompt: options.getSystemPrompt,
      getEntries: options.getEntries ?? (() => []),
    }
  }

  function createUI(mode: Extension.Mode): Extension.UIContext {
    const unsupported = (name: string) => {
      if (mode === "tui" || mode === "rpc") {
        // In full implementation, wire to actual TUI
        return () => Promise.resolve(undefined)
      }
      return () => Promise.resolve(undefined)
    }

    return {
      notify: (message: string, _type?: "info" | "warning" | "error") => {
        // Wire to TUI or console in full implementation
      },
      confirm: unsupported("confirm") as any,
      input: unsupported("input") as any,
      select: unsupported("select") as any,
    }
  }
}
