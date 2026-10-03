import type { SessionInfo } from "@opencode/client"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createMemo, createSignal } from "solid-js"
import { useConfig } from "../../config"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { SESSION_SIDEBAR_WIDTH } from "../../ui/layout"

// REDSUN: the session sidebar docks beside the transcript on wide terminals and overlays it
// otherwise. `session.sidebar` ("auto" | "hide") is the persisted default; the toggle also
// opens it for this visit.
export function useSidebarVisibility(session: () => SessionInfo | undefined) {
  const configState = useConfig()
  const dialog = useDialog()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const [open, setOpen] = createSignal(false)
  const width = createMemo(() => dimensions().width)
  const wide = createMemo(() => width() > 120)
  const visible = createMemo(() => {
    if (session()?.parentID) return false
    if (open()) return true
    return (configState.data.session?.sidebar ?? "auto") === "auto" && wide()
  })
  /** Columns left for the transcript, after the docked sidebar and the route's padding. */
  const contentWidth = createMemo(() => width() - (visible() && wide() ? SESSION_SIDEBAR_WIDTH : 0) - 4)

  const command = () => ({
    title: visible() ? "Hide sidebar" : "Show sidebar",
    id: "session.sidebar.toggle",
    group: "Session",
    run: () => {
      batch(() => {
        const isVisible = visible()
        void configState
          .update((draft) => {
            draft.session = { ...draft.session, sidebar: isVisible ? "hide" : "auto" }
          })
          .catch(toast.error)
        setOpen(!isVisible)
      })
      dialog.clear()
    },
  })

  return { visible, wide, contentWidth, command }
}
