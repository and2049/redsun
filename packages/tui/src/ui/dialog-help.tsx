import { TextAttributes } from "@opentui/core"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { useLanguage } from "../i18n"

export function DialogHelp() {
  const dialog = useDialog()
  const theme = useTheme("elevated")
  const shortcuts = Keymap.useShortcuts()
  const { t } = useLanguage()

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: t("Close help"), group: "Dialog", run: () => dialog.clear() },
      { bind: "escape", title: t("Close help"), group: "Dialog", run: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.default}>
          {t("Help")}
        </text>
        <text fg={theme.text.subdued} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.text.subdued}>
          {t("Press {{key}} to see all available actions and commands in any context.", {
            key: shortcuts.get("command.palette.show") ?? "",
          })}
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme.background.action.primary.focused}
          onMouseUp={() => dialog.clear()}
        >
          <text fg={theme.text.action.primary.focused}>{t("ok")}</text>
        </box>
      </box>
    </box>
  )
}
