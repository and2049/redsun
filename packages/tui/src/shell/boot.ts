// Boot and teardown for the dense native-scrollback shell.
//
// The dense UI keeps the terminal on the main screen buffer and runs the
// renderer in split-footer mode: finished transcript rows are committed into
// native terminal scrollback while the Solid tree paints the pinned footer
// region. At startup the footer takes over the whole viewport (Claude-style
// takeover), so prior shell content scrolls into scrollback and the app owns
// the screen immediately.
//
// Shutdown order matters (see packages/redsun/src/cli/cmd/run/runtime.lifecycle.ts):
// switch external output back to passthrough before leaving split-footer mode,
// so pending stdout doesn't get captured into the now-dead scrollback pipeline.
import type { CliRenderer, CliRendererConfig } from "@opentui/core"

// Renderer options for the dense shell. Mirrors the production `redsun --mini`
// boot options (runtime.lifecycle.ts): no mouse capture so native terminal
// select/copy works, kitty keyboard events on win32, and no clear on shutdown
// so the transcript stays in the terminal after exit.
export function rendererOptions(): CliRendererConfig {
  return {
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    autoFocus: false,
    openConsoleOnError: false,
    useMouse: false,
    useKittyKeyboard: { events: process.platform === "win32" },
    screenMode: "split-footer",
    footerHeight: takeoverHeight(),
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clearOnShutdown: false,
  }
}

// The startup takeover height: the whole viewport.
export function takeoverHeight(): number {
  return Math.max(1, process.stdout.rows ?? 24)
}

// Grows or shrinks the pinned footer region. No-op outside split-footer mode
// (e.g. under the test renderer) and when the height is unchanged.
export function applyFooterHeight(renderer: CliRenderer, rows: number): void {
  if (renderer.isDestroyed) return
  if (renderer.screenMode !== "split-footer") return
  const height = Math.max(1, Math.trunc(rows))
  if (renderer.footerHeight === height) return
  renderer.footerHeight = height
}

// Tears the dense renderer down in the required order:
// capture-stdout → passthrough, then split-footer → main-screen, then destroy.
export function shutdown(renderer: CliRenderer): void {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return

  if (renderer.externalOutputMode === "capture-stdout") {
    renderer.externalOutputMode = "passthrough"
  }

  if (renderer.screenMode === "split-footer") {
    renderer.screenMode = "main-screen"
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }
}
