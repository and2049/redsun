import { createMemo } from "solid-js"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { type DialogContext } from "../ui/dialog"
import { COMMAND_PALETTE_COMMAND, Keymap, type KeymapCommand } from "../context/keymap"
import { DialogConfig, settingID, settings } from "./dialog-config"
import { useLanguage } from "../i18n"

function isSuggestedPaletteCommand(command: KeymapCommand) {
  const suggested = command.suggested
  if (typeof suggested === "boolean") return suggested
  if (typeof suggested === "function") return suggested() === true
  return false
}

export function CommandPaletteDialog() {
  const { t } = useLanguage()
  const commands = Keymap.useCommands()
  const shortcuts = Keymap.useShortcuts()
  const options = createMemo(() =>
    commands().flatMap((command) => {
      if (!command.id || !command.palette || command.id === COMMAND_PALETTE_COMMAND) return []
      const footer = shortcuts.all(command.id)
      return {
        title: command.title ?? command.id,
        description: command.description,
        category: command.group,
        searchText: [command.id, command.description, command.slash?.name, ...(command.slash?.aliases ?? [])]
          .filter(Boolean)
          .join(" "),
        searchFooter: [command.group, footer].filter(Boolean).join(" · "),
        footer,
        value: command.id,
        suggested: isSuggestedPaletteCommand(command),
        onSelect: (dialog: DialogContext) => {
          dialog.clear()
          command.run()
        },
      }
    }),
  )
  const settingOptions = createMemo(() =>
    settings.map((setting) => ({
      title: t(setting.title),
      category: t(setting.category),
      searchText: [setting.title, setting.category, ...(setting.keywords ?? [])].join(" "),
      searchFooter: `${t("Settings")} · ${t(setting.category)}`,
      value: `setting:${settingID(setting)}`,
      onSelect: (dialog: DialogContext) => {
        dialog.replace(() => <DialogConfig current={settingID(setting)} />)
      },
    })),
  )

  let ref: DialogSelectRef<string>
  const list = () => {
    if (ref?.filter) return [...options(), ...settingOptions()]
    return [
      ...options()
        .filter((option) => option.suggested)
        .map((option) => ({
          ...option,
          value: `suggested:${option.value}`,
          category: t("Suggested"),
        })),
      ...options(),
    ]
  }

  return (
    <DialogSelect
      ref={(value) => (ref = value)}
      title={t("Commands")}
      options={list()}
      flat={true}
      filterThreshold={0.7}
    />
  )
}
