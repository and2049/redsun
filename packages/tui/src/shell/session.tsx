// Dense session view: transcript commits into native terminal scrollback
// while the bottom dock paints in the pinned footer region.
//
// The transcript engine only runs on a real dense renderer (split-footer +
// capture-stdout) — under other renderers (tests, classic fallback paths) the
// view still mounts the dock, epilogue, and prompt wiring, but scrollback
// writes are inert because writeToScrollback would throw.
import { CliRenderEvents } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { useEpilogue } from "../context/epilogue"
import { LocationProvider } from "../context/location"
import { usePathFormatter } from "../context/path-format"
import { usePromptRef } from "../context/prompt"
import { useRouteData } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useTuiPaths, useTuiTerminalEnvironment } from "../context/runtime"
import type { PromptRef } from "../component/prompt"
import { sessionEpilogue } from "../util/presentation"
import { normalizePath } from "../util/path"
import * as Locale from "../util/locale"
import { Dock } from "./dock"
import { useDenseSessionCommands } from "./session-commands"
import { useDenseSessionLifecycle } from "./session-lifecycle"
import { bannerWriter } from "./scrollback/writers"
import { createTranscriptReplay } from "./transcript/replay"

function directoryLabel(cwd: string, home: string): string {
  const display = cwd === home ? "~" : cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd
  return display.replaceAll("\\", "/")
}

// Blocks replayed after a scrollback reset. Older ones collapse into a note —
// a resize should not re-render an unbounded history.
const REPLAY_CAP = 400

// Newest messages whose parts the notify effect subscribes to. A completed
// turn is a user message plus one assistant message, so this covers the
// in-flight turn and the one before it.
const TRACKED_MESSAGES = 4

// DenseSession is keyed by session id, so a mount with an already-committed
// transcript behind it means the user switched sessions: that replay starts by
// clearing scrollback. The first session of the process keeps whatever the
// terminal already had above it (the takeover model).
let mounts = 0

export function DenseSession() {
  const route = useRouteData("session")
  const sync = useSync()
  const renderer = useRenderer()
  const themeState = useTheme()
  const { theme, syntax } = themeState
  const setEpilogue = useEpilogue()
  const promptRef = usePromptRef()
  const paths = useTuiPaths()
  const pathFormatter = usePathFormatter()
  const terminalEnvironment = useTuiTerminalEnvironment()

  const scrollbackActive = () =>
    !renderer.isDestroyed && renderer.screenMode === "split-footer" && renderer.externalOutputMode === "capture-stdout"

  const session = createMemo(() => sync.session.get(route.sessionID))
  const location = createMemo(() => {
    const current = session()
    return current ? { directory: current.directory, workspaceID: current.workspaceID } : undefined
  })

  useDenseSessionLifecycle()
  useDenseSessionCommands()

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    setEpilogue(sessionEpilogue({ title, sessionID: session()?.id }))
  })
  onCleanup(() => setEpilogue())

  let seeded = false
  const bind = (ref: PromptRef | undefined) => {
    promptRef.set(ref)
    if (seeded || !route.prompt || !ref) return
    seeded = true
    ref.set(route.prompt)
  }

  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  const visible = createMemo(() => !session()?.parentID && permissions().length === 0 && questions().length === 0)
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0)

  onMount(() => {
    if (!scrollbackActive()) return

    const switched = mounts++ > 0
    const replay = createTranscriptReplay({
      renderer,
      sessionID: route.sessionID,
      data: sync.data,
      theme: () => theme,
      syntax: () => syntax(),
      formatPath: pathFormatter.format,
      normalizePath: (path) => normalizePath(path, terminalEnvironment.platform),
      goalVerdict: (messageID) => sync.data.session_goal[route.sessionID]?.verdicts[messageID],
      revertedFrom: () => session()?.revert?.messageID,
      cap: REPLAY_CAP,
      active: scrollbackActive,
      resetOnStart: switched,
      banner: () => {
        const cwd = session()?.directory ?? paths.cwd
        renderer.writeToScrollback(bannerWriter({ detail: directoryLabel(cwd, paths.home), theme }))
      },
    })
    onCleanup(() => replay.dispose())

    // A terminal resize reflows already-committed rows, so the transcript is
    // re-written at the new width. Footer-height changes also emit RESIZE;
    // comparing terminal geometry keeps those from triggering a replay.
    let width = renderer.terminalWidth
    let height = renderer.terminalHeight
    const resized = () => {
      if (width === renderer.terminalWidth && height === renderer.terminalHeight) return
      width = renderer.terminalWidth
      height = renderer.terminalHeight
      replay.request("resize")
    }
    renderer.on(CliRenderEvents.RESIZE, resized)
    onCleanup(() => renderer.off(CliRenderEvents.RESIZE, resized))

    // Subscribe to the fields the block derivation reads so store updates
    // schedule a drain; the drain itself reads the store untracked.
    //
    // Only the newest few messages are tracked. Subscribing to every part of
    // every message costs O(session) on each streamed token, and older
    // messages are complete — their blocks are already committed, and
    // scrollback cannot be rewritten in place anyway. Appending a message
    // still notifies, because the messages array itself is tracked.
    createEffect(() => {
      void sync.data.session_goal[route.sessionID]?.lastVerdict
      void session()?.revert?.messageID
      const all = sync.data.message[route.sessionID] ?? []
      const messages = all.slice(-TRACKED_MESSAGES)
      for (const message of messages) {
        if (message.role === "assistant") {
          void message.time.completed
          void message.error
        }
        const parts = sync.data.part[message.id] ?? []
        for (const part of parts) {
          if (part.type === "text") {
            void part.text
            void part.time?.end
            void part.ignored
          } else if (part.type === "reasoning") {
            void part.text
            void part.time.end
          } else if (part.type === "tool") {
            void part.state.status
          }
        }
      }
      replay.notify()
    })
  })

  return (
    <LocationProvider location={location()}>
      <box width="100%" height="100%" flexDirection="column" justifyContent="flex-end">
        <Dock
          sessionID={route.sessionID}
          bind={bind}
          visible={visible()}
          disabled={disabled()}
          permissions={permissions()}
          questions={questions()}
        />
      </box>
    </LocationProvider>
  )
}
