// Dense session view: transcript commits into native terminal scrollback
// while the bottom dock paints in the pinned footer region.
//
// The transcript engine only runs on a real dense renderer (split-footer +
// capture-stdout) — under other renderers (tests, classic fallback paths) the
// view still mounts the dock, epilogue, and prompt wiring, but scrollback
// writes are inert because writeToScrollback would throw.
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useEpilogue } from "../context/epilogue"
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
import { applyFooterHeight } from "./boot"
import { Dock, DOCK_ROWS, DOCK_TALL_ROWS } from "./dock"
import { bannerWriter } from "./scrollback/writers"
import { createTranscriptCommitter } from "./transcript/committer"

function directoryLabel(cwd: string, home: string): string {
  const display = cwd === home ? "~" : cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd
  return display.replaceAll("\\", "/")
}

export function DenseSession() {
  const route = useRouteData("session")
  const sync = useSync()
  const renderer = useRenderer()
  const dialog = useDialog()
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

  // Footer-height policy: compact dock by default; grow for permission or
  // question prompts and floating dialogs (inline dock dialogs land in a
  // later phase); the resize path clamps automatically.
  createEffect(() => {
    const tall = dialog.stack.length > 0 || permissions().length > 0 || questions().length > 0
    const rows = tall ? Math.max(DOCK_TALL_ROWS, Math.floor(renderer.terminalHeight / 2)) : DOCK_ROWS
    applyFooterHeight(renderer, Math.min(rows, Math.max(1, renderer.terminalHeight)))
  })

  onMount(() => {
    if (!scrollbackActive()) return

    const cwd = session()?.directory ?? paths.cwd
    renderer.writeToScrollback(
      bannerWriter({
        detail: directoryLabel(cwd, paths.home),
        theme,
      }),
    )
    renderer.requestRender()

    const committer = createTranscriptCommitter({
      renderer,
      sessionID: route.sessionID,
      data: sync.data,
      theme: () => theme,
      syntax: () => syntax(),
      formatPath: pathFormatter.format,
      normalizePath: (path) => normalizePath(path, terminalEnvironment.platform),
      goalVerdict: (messageID) => sync.data.session_goal[route.sessionID]?.verdicts[messageID],
      wrote: true,
    })
    onCleanup(() => committer.dispose())

    // Subscribe to every field the block derivation reads so store updates
    // schedule a drain; the drain itself reads the store untracked.
    createEffect(() => {
      void sync.data.session_goal[route.sessionID]?.lastVerdict
      const messages = sync.data.message[route.sessionID] ?? []
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
      committer.notify()
    })
  })

  return (
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
  )
}
