// Transient dock surfaces paint over the transcript instead of scrolling it.
//
// OpenTUI sizes the Solid root to exactly `footerHeight`, so an absolute child
// cannot escape a compact split footer the way Claude Code's fullscreen Ink
// overlay can. The dense equivalent is to rebase the native output boundary
// to the requested surface top before growing the footer. The larger footer
// then owns those pixels without moving the transcript above it.
//
// Closing performs one authoritative transcript replay. This is deliberately
// coarser than restoring measured tail blocks: replay already owns every path
// that can invalidate native scrollback, and it remains correct while output
// streams, dialogs change height, or sessions switch.
import type { CliRenderer } from "@opentui/core"
import { applyFooterHeight, coverScrollbackTo, pinScrollback } from "./boot"

export type CoverController = {
  apply(rows: number, tall: boolean): void
  // Transcript commits are deferred while a transient surface owns their
  // pixels. The close replay includes every deferred store update.
  notify(): void
  dispose(): void
}

type Cover = {
  // Keep the largest height reached by this surface. Shrinking it in place
  // would expose rows whose transcript pixels were already overwritten.
  footer: number
}

export function createCoverController(input: {
  renderer: CliRenderer
  active: () => boolean
  // Reset and rebuild the transcript after a transient surface closes.
  restore: () => Promise<void>
  notify: () => void
}): CoverController {
  const renderer = input.renderer
  let generation = 0
  let cover: Cover | undefined
  let paused = false
  let pendingNotify = false
  let restoring = false
  let disposed = false
  let lastRows: number | undefined
  let lastTall = false

  const stale = (value: number) => disposed || value !== generation

  function resume(): void {
    paused = false
    if (!pendingNotify) return
    pendingNotify = false
    input.notify()
  }

  function directApply(rows: number, previous: number | undefined): void {
    applyFooterHeight(renderer, rows)
    if (previous !== undefined && rows < previous) pinScrollback(renderer)
  }

  async function open(value: number, rows: number): Promise<void> {
    paused = true
    try {
      await renderer.idle()
    } catch {}
    if (stale(value)) return

    const target = Math.max(0, renderer.terminalHeight - rows)
    if (!coverScrollbackTo(renderer, target)) {
      resume()
      directApply(rows, lastRows)
      return
    }
    applyFooterHeight(renderer, rows)
    cover = { footer: rows }
  }

  async function close(value: number, rows: number): Promise<void> {
    cover = undefined
    restoring = true
    applyFooterHeight(renderer, rows)
    try {
      await input.restore()
    } finally {
      restoring = false
      if (disposed) return
      if (value === generation) {
        resume()
        return
      }
      // A new transient surface may have opened while replay was rebuilding
      // the transcript. Re-apply it only after that authoritative restore.
      if (lastTall && lastRows !== undefined) {
        const next = ++generation
        void open(next, lastRows).catch(() => {})
      } else {
        resume()
      }
    }
  }

  return {
    apply(rows: number, tall: boolean) {
      if (disposed) return
      rows = Math.max(1, Math.trunc(rows))
      const previous = lastRows
      lastRows = rows
      lastTall = tall

      if (!input.active()) {
        cover = undefined
        paused = false
        pendingNotify = false
        directApply(rows, previous)
        return
      }

      const value = ++generation
      if (restoring) {
        if (!tall) applyFooterHeight(renderer, rows)
        return
      }
      if (!tall) {
        if (cover) void close(value, rows).catch(() => {})
        else {
          // The surface may have been dismissed while open() was awaiting
          // renderer idle, before it could publish `cover`.
          resume()
          directApply(rows, previous)
        }
        return
      }

      // A smaller menu still fits inside the pixels already owned by the
      // footer. Keep that high-water mark until close so no overwritten row
      // is exposed without a replay.
      if (cover && rows <= cover.footer) return
      void open(value, rows).catch(() => {})
    },
    notify() {
      if (disposed) return
      if (paused) {
        pendingNotify = true
        return
      }
      input.notify()
    },
    dispose() {
      disposed = true
      generation++
      cover = undefined
      paused = false
      pendingNotify = false
      restoring = false
    },
  }
}
