import { TextAttributes } from "@opentui/core"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { themeMode, useTheme, type ThemeMode } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { createMemo, createSignal, onCleanup } from "solid-js"

// Built-in dark/light siblings; used to keep the highlight on the matching
// theme when flipping between tabs.
const THEME_PAIRS: Record<string, string | undefined> = {
  dusk: "dawn",
  dawn: "dusk",
  everforest: "glade",
  glade: "everforest",
  gruvbox: "parchment",
  parchment: "gruvbox",
  kanagawa: "lotus",
  lotus: "kanagawa",
  rosepine: "petal",
  petal: "rosepine",
}

export function DialogThemeList() {
  const themes = useTheme()
  const { theme } = themes
  const dialog = useDialog()
  let confirmed = false
  let ref: DialogSelectRef<string>
  const initial = themes.selected
  const initialTab = themes.mode()
  const [tab, setTab] = createSignal<ThemeMode>(initialTab)

  const options = createMemo(() =>
    Object.entries(themes.all())
      .filter(([, json]) => themeMode(json) === tab())
      .map(([name]) => ({ title: name, value: name }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" })),
  )

  onCleanup(() => {
    if (!confirmed) themes.set(initial)
  })

  // The equivalent theme on the other tab, e.g. gruvbox <-> parchment.
  function counterpart(name: string, mode: ThemeMode) {
    const paired = THEME_PAIRS[name]
    if (paired) return paired
    // Custom themes commonly follow a -dark/-light suffix convention.
    return `${name.replace(/-(dark|light)$/, "")}-${mode}`
  }

  function switchTab(mode: ThemeMode) {
    if (tab() === mode) return
    const from = themes.selected
    setTab(mode)
    const all = themes.all()
    const twin = counterpart(from, mode)
    const target = all[twin] && themeMode(all[twin]) === mode ? twin : options()[0]?.value
    if (!target) return
    themes.set(target)
    ref?.moveTo(target)
  }

  function Tab(props: { label: string; mode: ThemeMode }) {
    const active = createMemo(() => tab() === props.mode)
    return (
      <text
        fg={active() ? theme.primary : theme.textMuted}
        attributes={active() ? TextAttributes.BOLD : undefined}
        onMouseUp={() => switchTab(props.mode)}
      >
        {props.label}
      </text>
    )
  }

  return (
    <DialogSelect
      title="Themes"
      titleView={
        <box flexDirection="row" gap={2}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Themes
          </text>
          <Tab label="Dark" mode="dark" />
          <Tab label="Light" mode="light" />
        </box>
      }
      options={options()}
      current={initial}
      onMove={(opt) => {
        themes.set(opt.value)
      }}
      onSelect={(opt) => {
        themes.set(opt.value)
        confirmed = true
        dialog.clear()
      }}
      ref={(r) => {
        ref = r
      }}
      onFilter={(query) => {
        if (query.length === 0) {
          if (tab() === initialTab) {
            themes.set(initial)
            return
          }
          const first = options()[0]
          if (first) themes.set(first.value)
          return
        }

        const first = ref.filtered[0]
        if (first) themes.set(first.value)
      }}
      bindings={[
        {
          key: "tab",
          desc: "Switch between dark and light themes",
          group: "Dialog",
          cmd: () => switchTab(tab() === "dark" ? "light" : "dark"),
        },
        {
          key: "shift+tab",
          desc: "Switch between dark and light themes",
          group: "Dialog",
          cmd: () => switchTab(tab() === "dark" ? "light" : "dark"),
        },
      ]}
      footerHints={[{ title: tab() === "dark" ? "Light themes" : "Dark themes", label: "tab" }]}
    />
  )
}
