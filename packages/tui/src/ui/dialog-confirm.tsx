import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useNewDesigns } from "../config"
import { DialogHeader, DialogLayout, useDialog } from "./dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { Locale } from "../util/locale"
import { useLanguage } from "../i18n"

export type DialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
  label?: {
    confirm?: string
    cancel?: string
  }
}

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const { t } = useLanguage()
  const newDesigns = useNewDesigns()
  const [store, setStore] = createStore({
    active: "confirm" as "confirm" | "cancel",
  })

  const choose = (key: "confirm" | "cancel") => {
    if (key === "confirm") props.onConfirm?.()
    if (key === "cancel") props.onCancel?.()
    dialog.clear()
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: newDesigns()
      ? [
          { bind: "return", title: "Confirm", group: "Dialog", run: () => choose("confirm") },
          { bind: "escape", title: "Cancel", group: "Dialog", run: () => choose("cancel") },
        ]
      : [
          {
            bind: "return",
            title: t("ui.confirmDialogSelection"),
            group: "Dialog",
            run: () => choose(store.active),
          },
          {
            bind: "left",
            title: t("ui.previousDialogOption"),
            group: "Dialog",
            run: () => {
              setStore("active", store.active === "confirm" ? "cancel" : "confirm")
            },
          },
          {
            bind: "right",
            title: t("ui.nextDialogOption"),
            group: "Dialog",
            run: () => {
              setStore("active", store.active === "confirm" ? "cancel" : "confirm")
            },
          },
        ],
  }))
  return (
    <DialogLayout
      header={<DialogHeader title={props.title} />}
      footer={{
        actions: {
          primary: [
            // Footer labels are lowercase; the legacy buttons title-case the same labels.
            { title: (props.label?.cancel ?? t("common.cancel")).toLowerCase(), key: "esc", onTrigger: () => choose("cancel") },
            {
              title: (props.label?.confirm ?? t("ui.confirm")).toLowerCase(),
              key: "enter",
              onTrigger: () => choose("confirm"),
            },
          ],
        },
      }}
      legacyFooter={
        <box flexDirection="row" justifyContent="flex-end">
          <For each={["cancel", "confirm"] as const}>
            {(key) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={key === store.active ? theme.background.action.primary.focused : undefined}
                onMouseUp={() => choose(key)}
              >
                <text fg={key === store.active ? theme.text.action.primary.focused : theme.text.muted}>
                  {props.label?.[key] ?? t(Locale.titlecase(key))}
                </text>
              </box>
            )}
          </For>
        </box>
      }
    >
      <text fg={theme.text.muted}>{props.message}</text>
    </DialogLayout>
  )
}
