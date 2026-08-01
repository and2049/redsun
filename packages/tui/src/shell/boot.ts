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
// forcing the surface offset to the pinned line — never by committing filler.
//
// OpenTUI's native model keeps the surface directly below committed output:
// a footer shrink strands it mid-screen, and only output commits push it down.
// Crucially, the engine tracks committed output (`published_rows`) separately
// from the surface offset: growth scrolls history only by the *output* gap and
// otherwise expands into blank rows, commits land at the output tail, and both
// commit and repaint frames clamp the surface to [output, pinned] — so a
// forced pin is stable, and content fills the gap between output and dock
// top-down, Claude Code style. (Committing spacer rows instead would advance
// the output counter to the dock and poison all of that: every footer grow
// would scroll real history and every shrink would add more spacers — a gap
// that widens on each `:`/dialog round-trip.)
//
// Called before the banner on every replay start and after any dock shrink.
// Settles through `idle()` first so pending commits and the shrink's deferred
// footer transition are consumed before the offset is measured and forced.
// `renderOffset`, `lib.setRenderOffset`, `clearStaleSplitSurfaceRows` and
// `forceFullRepaintRequested` are internal — pinned to @opentui/core 0.4.5.
export function pinScrollback(renderer: CliRenderer): void {
  void Promise.resolve(renderer.idle())
    .then(() => forcePin(renderer))
    .catch(() => {})
}

function forcePin(renderer: CliRenderer): void {
  if (renderer.isDestroyed) return
  if (renderer.screenMode !== "split-footer" || renderer.externalOutputMode !== "capture-stdout") return
  const internals = renderer as unknown as {
    renderOffset?: number
    rendererPtr?: unknown
    lib?: { setRenderOffset?: (ptr: unknown, offset: number) => void }
    getSplitPinnedRenderOffset?: () => number
    clearStaleSplitSurfaceRows?: (prevTop: number, prevHeight: number, nextTop: number, nextHeight: number) => void
    forceFullRepaintRequested?: boolean
  }
  const offset = internals.renderOffset
  if (typeof offset !== "number" || typeof internals.lib?.setRenderOffset !== "function") return
  const pinned =
    internals.getSplitPinnedRenderOffset?.() ?? Math.max(0, renderer.terminalHeight - renderer.footerHeight)
  if (offset >= pinned) return
  // Blank the vacated rows (old surface top through the row above the new
  // top); the repaint below covers only the new surface region.
  internals.clearStaleSplitSurfaceRows?.(offset + 1, pinned - offset, pinned + 1, renderer.terminalHeight - pinned)
  internals.renderOffset = pinned
  internals.lib.setRenderOffset(internals.rendererPtr, pinned)
  internals.forceFullRepaintRequested = true
  renderer.requestRender()
}

// Tears the dense renderer down in the required order:
// capture-stdout → passthrough, then split-footer → main-screen, then destroy.
export function shutdown(renderer: CliRenderer): void {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return

  // Decided before the mode flips below erase the evidence.
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
