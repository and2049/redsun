// Non-visual session behaviour shared with the classic route.
//
// The classic session view (routes/session/index.tsx) owns more than layout:
// it loads the session, follows workspace changes, reconnects the editor, and
// reacts to a couple of events. None of that is presentational, and the dense
// shell never mounts that component, so it is re-registered here. Anything
// that only makes sense with a scrollbox (scroll restore, message-position
// helpers) is deliberately left behind.
import { createEffect, untrack } from "solid-js"
import { useEditorContext } from "../context/editor"
import { useEvent } from "../context/event"
import { useKV } from "../context/kv"
import { useLocal } from "../context/local"
import { useProject } from "../context/project"
import { useRoute, useRouteData } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { DialogRetryAction } from "../component/dialog-retry-action"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

// Upsell throttling keys, duplicated from the classic route (they are
// file-private there). Keeping the same key names means the "don't show
// again" choice carries across both UIs.
const GO_UPSELL_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at"
const GO_UPSELL_FREE_TIER_DONT_SHOW = "go_upsell_dont_show"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show"
const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs
const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"])

function goUpsellKeys(action: { provider: string; reason: string } | undefined) {
  if (!action) return
  if (!GO_UPSELL_PROVIDERS.has(action.provider)) return
  if (action.reason === "free_tier_limit") {
    return { lastSeenAt: GO_UPSELL_FREE_TIER_LAST_SEEN_AT, dontShow: GO_UPSELL_FREE_TIER_DONT_SHOW }
  }
  if (action.reason === "account_rate_limit") {
    return {
      lastSeenAt: GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT,
      dontShow: GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW,
    }
  }
}

export function useDenseSessionLifecycle() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const editor = useEditorContext()
  const event = useEvent()
  const local = useLocal()
  const dialog = useDialog()
  const toast = useToast()
  const kv = useKV()

  // Load the session: without this the transcript has nothing to commit.
  // A session in another workspace switches the workspace first, and a
  // failed bootstrap is non-fatal — the session still shows, read-only.
  createEffect(() => {
    const sessionID = route.sessionID
    void (async () => {
      const previousWorkspace = untrack(() => project.workspace.current())
      const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
      if (!result.data) {
        toast.show({ message: `Session not found: ${sessionID}`, variant: "error", duration: 5000 })
        navigate({ type: "home" })
        return
      }

      if (result.data.workspaceID !== previousWorkspace) {
        project.workspace.set(result.data.workspaceID)
        try {
          await sync.bootstrap({ fatal: false })
        } catch {}
      }
      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
      navigate({ type: "home" })
    })
  })

  // The plan tools switch the active agent as a side effect of completing.
  let lastSwitch: string | undefined
  event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  event.on("session.status", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    if (evt.properties.status.type !== "retry") return
    const action = evt.properties.status.action
    if (!action) return
    if (dialog.stack.length > 0) return

    const keys = goUpsellKeys(action)
    if (!keys) return

    const seen = kv.get(keys.lastSeenAt)
    if (typeof seen === "number" && Date.now() - seen < GO_UPSELL_WINDOW) return
    if (kv.get(keys.dontShow)) return

    void DialogRetryAction.show(dialog, action).then((dontShowAgain) => {
      if (dontShowAgain) kv.set(keys.dontShow, true)
      kv.set(keys.lastSeenAt, Date.now())
    })
  })
}
