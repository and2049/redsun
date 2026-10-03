import type { SessionInfo } from "@opencode/client"
import { createMemo } from "solid-js"
import { useData } from "../../context/data"
import { useRoute, useRouteData } from "../../context/route"
import { useLanguage } from "../../i18n"
import { useDialog } from "../../ui/dialog"
import { activeChildren, childSessions, nextChild, nextInActiveList } from "./child-navigation"
import { listHidden, setListHidden } from "./subagent-list"

// REDSUN: the session route works across the whole family, the root and its subagent
// children: their permissions and forms dock here, and the children are navigable in place.
export function useSessionFamily(session: () => SessionInfo | undefined) {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const data = useData()
  const dialog = useDialog()
  const language = useLanguage()

  const family = createMemo(() =>
    data.session.family(route.sessionID).flatMap((sessionID) => {
      const info = data.session.get(sessionID)
      return info ? [info] : []
    }),
  )
  const children = createMemo(() => childSessions(family()))
  const active = createMemo(() => activeChildren(children(), data.session.status))
  const root = createMemo(() => family().find((info) => !info.parentID))
  const sessionIDs = createMemo(() => family().map((info) => info.id))

  const enter = (sessionID: string) => navigate({ type: "session", sessionID })

  function moveFirst() {
    const next = children()[0]
    if (next) enter(next.id)
  }

  function move(direction: number) {
    const target = nextChild(children(), session()?.id, direction)
    if (target) enter(target.id)
  }

  function moveActive(direction: number) {
    const current = root()
    if (!current || active().length === 0 || dialog.stack.length > 0) return
    if (listHidden()) {
      if (direction > 0) setListHidden(false)
      return
    }
    if (direction < 0 && session()?.id === current.id) {
      setListHidden(true)
      return
    }
    const target = nextInActiveList(active(), current.id, session()?.id, direction)
    if (target) enter(target)
  }

  /** A command that only acts from a child session with no dialog open. */
  function fromChild(run: () => void) {
    return () => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      run()
      dialog.clear()
    }
  }

  const listCommands = () => [
    {
      id: "session.child.list.next",
      title: language.t("session.nextActiveSubagent"),
      group: "Session",
      palette: undefined,
      run: () => moveActive(1),
    },
    {
      id: "session.child.list.previous",
      title: language.t("session.previousActiveSubagent"),
      group: "Session",
      palette: undefined,
      run: () => moveActive(-1),
    },
  ]

  return { sessionIDs, children, active, root, enter, moveFirst, move, fromChild, listCommands }
}
