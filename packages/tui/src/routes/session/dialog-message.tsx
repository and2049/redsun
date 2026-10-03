import { createMemo, createSignal, onCleanup } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect } from "../../ui/dialog-select"
import { useClipboard } from "../../context/clipboard"
import { useToast } from "../../ui/toast"
import { useClient } from "../../context/client"
import { errorMessage } from "../../util/error"
import { DialogFork } from "./dialog-fork"
import type { PromptInfo } from "../../prompt/history"
import { projectedPromptInput } from "../../prompt/codec"
import { useLanguage } from "../../i18n"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
  onJump?: (messageID: string) => void
}) {
  const data = useData()
  const clipboard = useClipboard()
  const toast = useToast()
  const client = useClient()
  const message = createMemo(() => data.session.message.get(props.sessionID, props.messageID))
  const { t } = useLanguage()
  const [busy, setBusy] = createSignal(false)
  let alive = true
  onCleanup(() => {
    alive = false
  })
  const pinned = () => data.session.pins.list(props.sessionID).some((pin) => pin.messageID === props.messageID)

  return (
    <DialogSelect
      title={t("session.messageActions")}
      locked={busy()}
      options={[
        {
          title: t("session.jumpTo"),
          value: "message.jump",
          description: t("session.viewMessageInSession"),
          onSelect: (dialog) => {
            dialog.clear()
            props.onJump?.(props.messageID)
          },
        },
        {
          title: t(pinned() ? "pins.unpin" : "pins.pin"),
          value: "message.pin",
          disabled: message()?.type !== "user" && message()?.type !== "assistant",
          onSelect: (dialog) => {
            if (busy()) return
            setBusy(true)
            void data.session.pins
              .toggle(props.sessionID, props.messageID)
              .then(() => {
                if (alive) dialog.clear()
              })
              .catch((error) => {
                if (alive) toast.error(error)
              })
              .finally(() => {
                if (alive) setBusy(false)
              })
          },
        },
        {
          title: t("session.revert"),
          value: "session.revert",
          disabled: message()?.type !== "user",
          description: t("session.undoMessagesAndFileChanges"),
          onSelect: (dialog) => {
            const value = message()
            if (value?.type === "user") {
              props.setPrompt?.({
                ...projectedPromptInput(value),
                pasted: [],
              })
            }
            void client.api.session.revert
              .stage({ sessionID: props.sessionID, messageID: props.messageID })
              .catch((error) => toast.show({ message: errorMessage(error), variant: "error", duration: 5000 }))
            dialog.clear()
          },
        },
        {
          title: t("session.copy"),
          value: "message.copy",
          description: t("session.messageTextToClipboard"),
          onSelect: async (dialog) => {
            const value = message()
            if (!value) return
            const text =
              value.type === "user"
                ? value.text
                : value.type === "assistant"
                  ? value.content
                      .filter((content) => content.type === "text")
                      .map((content) => content.text)
                      .join("\n")
                  : "text" in value
                    ? value.text
                    : ""
            try {
              await clipboard.write(text)
              dialog.clear()
            } catch (error) {
              toast.error(error)
            }
          },
        },
        {
          title: t("session.fork"),
          value: "session.fork",
          disabled: message()?.type !== "user",
          description: t("session.createANewSession"),
          onSelect: (dialog) => {
            const value = message()
            if (!value || value.type !== "user") return
            dialog.replace(() => <DialogFork sessionID={props.sessionID} messageID={props.messageID} />)
          },
        },
      ]}
    />
  )
}
