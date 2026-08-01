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
import type { CliRenderer, CliRendererConfig, RGBA } from "@opentui/core"
import { spacerWriter } from "./scrollback/writers"

// Whether anything was committed into native scrollback this run. The session
// banner is the first write on every path that commits (see session.tsx), so
// one flag is enough. Quitting with it still false means the terminal shows
// nothing but our takeover frame — shutdown clears it instead of leaving a
// dead home screen behind (transcripts, by contrast, are the point of native
// scrollback and are left in place).
let committed = false

export function markScrollbackCommit(): void {
  committed = true
}

// Renderer options for the dense shell. Mirrors the production `redsun --mini`
// boot options (runtime.lifecycle.ts): no mouse capture so native terminal
// select/copy works, kitty keyboard events on win32, and no clear on shutdown
// so the transcript stays in the terminal after exit.
export function rendererOptions(): CliRendererConfig {
  committed = false
  backgroundApplied = false
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

// Raw terminal write, bypassing the capture-stdout interception (which would
// swallow control sequences into the scrollback pipeline). `writeOut` is the
// renderer's own internal writer — pinned to @opentui/core 0.4.5.
function writeRaw(renderer: CliRenderer, data: string): void {
  const writeOut = (renderer as unknown as { writeOut?: (chunk: string) => void }).writeOut
  if (typeof writeOut === "function") writeOut.call(renderer, data)
}

// Whether we changed the terminal's default background (OSC 11); shutdown
// resets it (OSC 111) so the user's terminal comes back untinted.
let backgroundApplied = false

// Sets the terminal's default background colour to the theme background.
//
// Committed scrollback rows carry no explicit background, so they normally
// render on whatever the terminal is configured with — which breaks themes and
// light/dark switching. OSC 11 recolours every default-background cell at
// once (transcript, voids, the lot) and retroactively follows theme switches.
// Terminals without OSC 11 support ignore it and keep today's behaviour.
export function applyTerminalBackground(renderer: CliRenderer, color: RGBA): void {
  if (renderer.isDestroyed) return
  if (renderer.screenMode !== "split-footer") return
  const [r, g, b] = color.toInts()
  const hex = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")
  writeRaw(renderer, `\x1b]11;rgb:${hex(r)}/${hex(g)}/${hex(b)}\x07`)
  backgroundApplied = true
}

// Erases the terminal's saved-lines buffer so scrolling up stops at the app
// itself instead of drifting into pre-launch shell history — the same
// behaviour as Claude Code's startup. One-shot at dense boot; per-session
// replays clear saved lines themselves.
export function clearTerminalHistory(renderer: CliRenderer): void {
  if (renderer.isDestroyed) return
  if (renderer.screenMode !== "split-footer") return
  writeRaw(renderer, "\x1b[3J")
}

// Pins the dock (the split-footer surface) to the bottom of the terminal by
// committing blank filler lines for the vertical gap above it.
//
// OpenTUI re-pins the surface when the footer grows but lets a shrink settle
// lazily: the surface keeps its old top line — leaving cleared rows below the
// dock — until future scrollback commits push it down, which an idle session
// never sends. Called before the banner on every replay start (so the
// transcript stacks upward from the dock, not down from a blank screen top)
// and after any dock shrink (picker, command bar, or completion closing).
//
// `renderOffset` and `externalOutputQueue` are internal renderer state, not
// public API — pinned to @opentui/core 0.4.5. Queued commits move the surface
// when they flush, so measuring the gap while any are pending would
// double-fill; those calls settle through `idle()` first.
export function pinScrollback(renderer: CliRenderer): void {
  const internals = renderer as unknown as { externalOutputQueue?: { size?: number } }
  if ((internals.externalOutputQueue?.size ?? 0) > 0) {
    void Promise.resolve(renderer.idle())
      .then(() => fillToBottom(renderer))
      .catch(() => {})
    return
  }
  fillToBottom(renderer)
}

function fillToBottom(renderer: CliRenderer): void {
  if (renderer.isDestroyed) return
  if (renderer.screenMode !== "split-footer" || renderer.externalOutputMode !== "capture-stdout") return
  const offset = (renderer as unknown as { renderOffset?: number }).renderOffset
  if (typeof offset !== "number") return
  const pinned = Math.max(0, renderer.terminalHeight - renderer.footerHeight)
  const gap = Math.min(renderer.terminalHeight, Math.max(0, pinned - offset))
  for (let index = 0; index < gap; index++) {
    renderer.writeToScrollback(spacerWriter())
  }
}

// Tears the dense renderer down in the required order:
// capture-stdout → passthrough, then split-footer → main-screen, then destroy.
export function shutdown(renderer: CliRenderer): void {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return

  // Decided before the mode flips below erase the evidence. Saved lines are
  // untouched, so whatever the takeover scrolled away at startup is still in
  // the terminal's own scrollback.
  const clear = !committed && renderer.screenMode === "split-footer"

  if (renderer.externalOutputMode === "capture-stdout") {
    renderer.externalOutputMode = "passthrough"
  }

  if (renderer.screenMode === "split-footer") {
    renderer.screenMode = "main-screen"
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }

  if (clear) {
    process.stdout.write("\x1b[H\x1b[2J")
  }
  if (backgroundApplied) {
    // Post-destroy stdout is the real stream again. OSC 111 restores the
    // terminal's own default background.
    process.stdout.write("\x1b]111\x07")
    backgroundApplied = false
  }
}
