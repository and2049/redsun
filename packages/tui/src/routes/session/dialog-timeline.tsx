import { createMemo, onMount } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../prompt/history"
import { useLanguage } from "../../i18n"

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
  includeAssistant?: boolean
}) {
  const data = useData()
  const dialog = useDialog()
  const { t } = useLanguage()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = data.session.message.list(props.sessionID)
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      if (message.type !== "user" && (!props.includeAssistant || message.type !== "assistant")) continue
      result.push({
        title:
          (message.type === "user"
            ? message.text
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(" ")
          ).replace(/\n/g, " ") || t(message.type === "user" ? "pins.user" : "pins.assistant"),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => {
          dialog.replace(() => (
            <DialogMessage
              messageID={message.id}
              sessionID={props.sessionID}
              setPrompt={props.setPrompt}
              onJump={props.onMove}
            />
          ))
        },
      })
    }
    result.reverse()
    return result
  })

  return (
    <DialogSelect onMove={(option) => props.onMove(option.value)} title={t("session.timeline")} options={options()} />
  )
}
