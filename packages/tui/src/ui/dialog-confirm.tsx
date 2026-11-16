import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useNewDesigns } from "../config"
import { DialogButtons, DialogHeader, DialogLayout, useDialog } from "./dialog"
import { createStore } from "solid-js/store"
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

const keys = ["cancel", "confirm"] as const

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

  const toggle = () => setStore("active", store.active === "confirm" ? "cancel" : "confirm")

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: t("ui.confirmDialogSelection"), group: "Dialog", run: () => choose(store.active) },
      { bind: "left", title: t("ui.previousDialogOption"), group: "Dialog", run: toggle },
      { bind: "right", title: t("ui.nextDialogOption"), group: "Dialog", run: toggle },
      { bind: "tab", title: t("ui.nextDialogOption"), group: "Dialog", run: toggle },
      { bind: "shift+tab", title: t("ui.previousDialogOption"), group: "Dialog", run: toggle },
      ...(newDesigns() ? [{ bind: "escape", title: t("common.cancel"), group: "Dialog", run: () => choose("cancel") }] : []),
    ],
  }))
  return (
    <DialogLayout
      header={<DialogHeader title={props.title} />}
      buttons={
        <DialogButtons
          buttons={keys.map((key) => ({
            label: Locale.titlecase(props.label?.[key] ?? t(Locale.titlecase(key))),
            run: () => choose(key),
          }))}
          active={keys.indexOf(store.active)}
          onActive={(index) => setStore("active", keys[index]!)}
        />
      }
    >
      <text fg={theme.text.muted}>{props.message}</text>
    </DialogLayout>
  )
}
