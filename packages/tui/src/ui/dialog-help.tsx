import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogLayout, useDialog } from "./dialog"
import { useLanguage } from "../i18n"

export function DialogHelp() {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const shortcuts = Keymap.useShortcuts()
  const { t } = useLanguage()

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: t("ui.closeHelp"), group: "Dialog", run: () => dialog.clear() },
      { bind: "escape", title: t("ui.closeHelp"), group: "Dialog", run: () => dialog.clear() },
    ],
  }))

  return (
    <DialogLayout
      header={<DialogHeader title={t("sidebar.help")} closeLabel="esc/enter" />}
      footer={{ actions: { primary: [{ title: t("ui.ok").toLowerCase(), key: "enter", onTrigger: () => dialog.clear() }] } }}
      legacyFooter={
        <box flexDirection="row" justifyContent="flex-end">
          <box
            paddingLeft={3}
            paddingRight={3}
            backgroundColor={theme.background.action.primary.focused}
            onMouseUp={() => dialog.clear()}
          >
            <text fg={theme.text.action.primary.focused}>{t("ui.ok")}</text>
          </box>
        </box>
      }
    >
      <text fg={theme.text.muted}>
        {t("ui.pressToSeeAllAvailableActionsAndCommands", {
          key: shortcuts.get("command.palette.show") ?? "",
        })}
      </text>
    </DialogLayout>
  )
}
