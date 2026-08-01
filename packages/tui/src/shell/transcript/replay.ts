// Owns the transcript committer and rebuilds it when committed scrollback
// stops being valid.
//
// Rows written to native scrollback cannot be edited, so everything that
// invalidates them is funnelled through one mechanism: clear the scrollback,
// re-write the session banner, and drain a fresh committer over the current
// store. Three things trigger it:
//
//   resize   the terminal reflows committed rows to the new width, which
//            mangles anything the writers laid out by hand (gutters, diffs)
//   revert   a revert/redo truncates or restores the derived block list, so
//            the committer desyncs (see committer.ts) and hands over here
//   session  switching sessions replaces the transcript entirely
//
// Resize replays are debounced (a drag emits a RESIZE per column) and bounded
// by `cap`, so a very long session does not re-render its whole history on
// every wobble.
import type { CliRenderer } from "@opentui/core"
import { createTranscriptCommitter, type CommitterInput, type TranscriptCommitter } from "./committer"

export type ReplayReason = "resize" | "revert" | "session"

export type ReplayInput = Omit<CommitterInput, "wrote" | "cap" | "onDesync"> & {
  // Pins the dock to the terminal bottom (see boot.ts pinScrollback). Called
  // before `banner` on every start and reset so the transcript stacks upward
  // from the dock instead of starting at the top of a fresh screen.
  pin?: () => void
  // Writes the session banner (or anything else that heads the transcript).
  // Called once at start and again after every scrollback reset.
  banner: () => void
  // Blocks written by a replay drain; older ones collapse into a note.
  cap?: number
  // Coalescing window for resize storms, in milliseconds.
  debounceMs?: number
  // False when the renderer cannot write scrollback (test renderers, classic
  // fallback) — replays are skipped rather than throwing.
  active: () => boolean
  // Reset scrollback before the very first commit. True when arriving from
  // another session, false on the first session of the process (where the
  // terminal's existing content is deliberately left alone).
  resetOnStart?: boolean
  onReplay?: (reason: ReplayReason) => void
}

export type TranscriptReplay = {
  // Schedule a drain of the live committer.
  notify(): void
  // Schedule a replay. Resize is debounced; other reasons run on the next tick.
  request(reason: ReplayReason): void
  // Run any scheduled replay immediately and wait for the committer to settle.
  flush(): Promise<void>
  // Number of completed replays (excluding the initial commit).
  readonly replays: number
  dispose(): void
}

const DEFAULT_DEBOUNCE_MS = 250

export function createTranscriptReplay(input: ReplayInput): TranscriptReplay {
  const renderer: CliRenderer = input.renderer
  let disposed = false
  let running = false
  let replays = 0
  let pending: ReplayReason | undefined
  let scheduled: ReplayReason | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function build(): TranscriptCommitter {
    return createTranscriptCommitter({
      ...input,
      wrote: true,
      cap: input.cap,
      onDesync: () => request("revert"),
    })
  }

  function reset(): void {
    // Throws off split-footer/capture-stdout or on a suspended terminal; the
    // caller has already checked, so treat a late failure as "nothing to
    // clear" and carry on with a fresh committer.
    try {
      renderer.resetSplitFooterForReplay({ clearSavedLines: true })
    } catch {}
  }

  if (input.resetOnStart && input.active()) reset()
  input.pin?.()
  input.banner()
  renderer.requestRender()
  let committer = build()
  committer.notify()

  async function run(reason: ReplayReason): Promise<void> {
    if (disposed || running) return
    running = true
    try {
      // Let the outgoing committer finish its in-flight write before its
      // stream surface is destroyed under it.
      await committer.idle()
      if (disposed) return
      if (!input.active()) return

      committer.dispose()
      reset()
      input.pin?.()
      input.banner()
      renderer.requestRender()
      committer = build()
      replays++
      input.onReplay?.(reason)
      committer.notify()
    } finally {
      running = false
      if (!disposed && pending) {
        const next = pending
        pending = undefined
        void run(next)
      }
    }
  }

  function request(reason: ReplayReason): void {
    if (disposed) return
    if (running) {
      pending = reason
      return
    }
    // A pending resize replay is subsumed by any other reason arriving later,
    // and vice versa — one reset covers both.
    if (timer) clearTimeout(timer)
    scheduled = reason
    timer = setTimeout(
      () => {
        timer = undefined
        scheduled = undefined
        void run(reason)
      },
      reason === "resize" ? (input.debounceMs ?? DEFAULT_DEBOUNCE_MS) : 0,
    )
  }

  return {
    notify() {
      if (disposed) return
      committer.notify()
    },
    request,
    async flush() {
      // A drain can schedule a replay (desync) and a replay drains again, so
      // settle both in turn. The store is stable by the time this is called,
      // so the alternation terminates; the bound is a test-only backstop.
      for (let attempt = 0; attempt < 8; attempt++) {
        await committer.idle()
        while (running) await new Promise<void>((resolve) => setTimeout(resolve, 0))
        if (disposed || !timer) return
        clearTimeout(timer)
        timer = undefined
        const reason = scheduled ?? "resize"
        scheduled = undefined
        await run(reason)
      }
    },
    get replays() {
      return replays
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      committer.dispose()
    },
  }
}
