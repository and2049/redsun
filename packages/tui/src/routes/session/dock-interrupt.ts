import { createMemo } from "solid-js"
import { useClient } from "../../context/client"
import { Keymap } from "../../context/keymap"
import { useLanguage } from "../../i18n"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"

// REDSUN: the composer (and its interrupt command) is unmounted while an approval or form owns
// the dock. Keep interruption available there, targeting the displayed request's session,
// including a worker's. Like the composer's, it takes a second press within five seconds.
export function useDockInterrupt(pending: () => { readonly id: string; readonly sessionID: string } | undefined) {
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()
  const language = useLanguage()
  const keys = Keymap.useShortcuts()
  const current = createMemo(pending)
  let armed: { id: string; at: number } | undefined
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !!current() && dialog.stack.length === 0,
    commands: [
      {
        id: "session.interrupt",
        title: "Interrupt session",
        group: "Session",
        run: () => {
          const request = current()
          if (!request || request.sessionID === "global") return
          const now = Date.now()
          if (armed?.id !== request.id || now - armed.at > 5_000) {
            armed = { id: request.id, at: now }
            toast.show({
              message: `${keys.get("session.interrupt")} ${language.t("session.againToInterrupt")}`,
              variant: "info",
            })
            return
          }
          armed = undefined
          void client.api.session
            .interrupt({ sessionID: request.sessionID, resume: true })
            .catch((error) => toast.error(error))
        },
      },
    ],
    bindings: ["session.interrupt"],
  }))
}
