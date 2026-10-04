import { TextAttributes, type RGBA } from "@opentui/core"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { loadTheme, themeMode, useTheme, useThemes } from "../context/theme"
import type { ThemeDocumentSource } from "../theme"
import { tint } from "../theme/color"
import { useDialog } from "../ui/dialog"
import { useLanguage } from "../i18n"

type Mode = "dark" | "light"

// Built-in dark/light siblings. A family is keyed by its dark member so the
// list order is the dark names' alphabetical order.
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
  cloud: "nimbus",
  nimbus: "cloud",
  wave: "tide",
  tide: "wave",
}

export type ThemeFamily = { key: string; dark?: string; light?: string }

// One row per family: built-in siblings pair by table, custom themes by a
// -dark/-light suffix, and anything else is a family of one. Two themes that
// claim the same family and mode cannot share a row, so the later one keeps
// its own.
export function themeFamilies(all: Record<string, ThemeDocumentSource>): ThemeFamily[] {
  const compare = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" })
  const families = new Map<string, ThemeFamily>()
  for (const name of Object.keys(all).sort(compare)) {
    const mode = themeMode(all[name], name)
    const key = familyKey(name, mode)
    const family = families.get(key)
    if (family?.[mode]) {
      families.set(name, { key: name, [mode]: name })
      continue
    }
    families.set(key, { ...(family ?? { key }), [mode]: name })
  }
  return [...families.values()].sort((a, b) => compare(a.key, b.key))
}

function familyKey(name: string, mode: Mode) {
  const paired = THEME_PAIRS[name]
  if (paired) return mode === "dark" ? name : paired
  return name.replace(/-(dark|light)$/, "")
}

// The theme a family shows in a mode; a family of one shows its only member.
export function familyMember(family: ThemeFamily, mode: Mode) {
  return family[mode] ?? family.dark ?? family.light!
}

// Hue squares shown after the background swatch on each row.
const SWATCH_HUES = 3

// Right-aligned preview on each row: the theme's background, then its first
// distinct categorical hues. The picker previews the highlighted theme live,
// but the swatches let the eye compare the rest of the list without moving.
// A row is highlighted only while its own theme is previewed, so a hue equal
// to that theme's row highlight would vanish exactly when the row is active
// and is skipped.
export function themeSwatches(source: ThemeDocumentSource, name: string) {
  let loaded: ReturnType<typeof loadTheme>
  try {
    loaded = loadTheme(source, name)
  } catch {
    return undefined
  }
  const { mode, theme } = loaded
  const step = mode === "light" ? 800 : 200
  const background = theme.background.base
  const highlight = theme.surface("dialog").background.action.primary.focused
  const hues: RGBA[] = []
  for (const scale of theme.categorical) {
    const color = scale[step]
    if (!color || color.toInts()[3] === 0) continue
    if (color.equals(highlight) || color.equals(background)) continue
    if (hues.some((seen) => seen.equals(color))) continue
    hues.push(color)
    if (hues.length === SWATCH_HUES) break
  }
  return (
    <>
      <span style={{ fg: background }}>■</span>
      {hues.map((color) => (
        <span style={{ fg: color }}> ■</span>
      ))}
    </>
  )
}

export function DialogThemeList() {
  const themes = useThemes()
  const theme = useTheme().surface("dialog")
  const dialog = useDialog()
  const { t } = useLanguage()
  let confirmed = false
  let ref: DialogSelectRef<string>
  const initial = themes.selected
  const [mode, setMode] = createSignal<Mode>(themes.mode())
  // The row under the cursor. `text.subdued` is tuned for the dialog surface
  // and can vanish on the highlight bar (dusk's yellow, wave's sky), so the
  // de-emphasised member of the highlighted row blends the bar's own
  // foreground toward its background instead.
  const [highlighted, setHighlighted] = createSignal<string | undefined>()
  const DIM_ON_HIGHLIGHT = 0.55
  const dimmed = createMemo(() =>
    tint(theme.background.action.primary.focused, theme.text.action.primary.focused, DIM_ON_HIGHLIGHT),
  )

  const families = createMemo(() => themeFamilies(themes.all()))
  const byKey = (key: string) => families().find((family) => family.key === key)
  const initialFamily = createMemo(
    () => families().find((family) => family.dark === initial || family.light === initial)?.key,
  )

  // Row title: "dusk / dawn" with the member shown in the current mode bold
  // and inheriting the row colour, the other subdued. Rebuilt when the mode
  // flips, along with the swatches, which follow the shown member.
  function FamilyTitle(props: { family: ThemeFamily; mode: Mode }) {
    const shown = familyMember(props.family, props.mode)
    const members = [props.family.dark, props.family.light].filter((name): name is string => Boolean(name))
    const quiet = () => ((highlighted() ?? initialFamily()) === props.family.key ? dimmed() : theme.text.muted)
    return (
      <>
        {members.map((name, index) => (
          <>
            {index > 0 && <span style={{ fg: quiet() }}> / </span>}
            {name === shown ? (
              <span style={{ attributes: TextAttributes.BOLD }}>{name}</span>
            ) : (
              <span style={{ fg: quiet() }}>{name}</span>
            )}
          </>
        ))}
      </>
    )
  }

  const options = createMemo(() => {
    const all = themes.all()
    return families().map((family) => {
      const shown = familyMember(family, mode())
      return {
        title: [family.dark, family.light].filter(Boolean).join(" / "),
        titleView: <FamilyTitle family={family} mode={mode()} />,
        value: family.key,
        footer: themeSwatches(all[shown], shown),
      }
    })
  })

  onCleanup(() => {
    if (!confirmed) themes.set(initial)
  })

  function preview(key: string | undefined, next = mode()) {
    const family = key === undefined ? undefined : byKey(key)
    if (!family) return
    setHighlighted(family.key)
    themes.set(familyMember(family, next))
  }

  // Tab flips the mode in place: the highlighted row stays put and previews
  // its other member, and every row re-emphasises the member it now shows.
  function switchMode(next: Mode) {
    if (mode() === next) return
    setMode(next)
    preview(ref?.selected?.value ?? initialFamily(), next)
  }

  function Tab(props: { label: string; mode: Mode }) {
    const active = createMemo(() => mode() === props.mode)
    return (
      <text
        fg={active() ? theme.text.action.primary.selected : theme.text.muted}
        attributes={active() ? TextAttributes.BOLD : undefined}
        onMouseUp={() => switchMode(props.mode)}
      >
        {props.label}
      </text>
    )
  }

  return (
    <DialogSelect
      title={t("ui.themes")}
      titleView={
        <box flexDirection="row" gap={2}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            {t("ui.themes")}
          </text>
          <Tab label={t("theme.scheme.dark")} mode="dark" />
          <Tab label={t("theme.scheme.light")} mode="light" />
        </box>
      }
      options={options()}
      current={initialFamily()}
      onMove={(opt) => preview(opt.value)}
      onSelect={(opt) => {
        preview(opt.value)
        confirmed = true
        dialog.clear()
      }}
      ref={(r) => {
        ref = r
      }}
      onFilter={(query) => {
        if (query.length === 0) {
          preview(initialFamily())
          return
        }
        preview(ref.filtered[0]?.value)
      }}
      bindings={[
        {
          bind: "tab",
          title: "Switch between dark and light themes",
          group: "Dialog",
          run: () => switchMode(mode() === "dark" ? "light" : "dark"),
        },
        {
          bind: "shift+tab",
          title: "Switch between dark and light themes",
          group: "Dialog",
          run: () => switchMode(mode() === "dark" ? "light" : "dark"),
        },
        {
          bind: "ctrl+b",
          title: "Toggle terminal background",
          group: "Dialog",
          run: () => themes.setTerminalBackground(!themes.terminalBackground()),
        },
      ]}
      footerHints={[
        { title: mode() === "dark" ? t("ui.lightThemes") : t("ui.darkThemes"), label: "tab" },
        {
          title: themes.terminalBackground() ? t("ui.terminalBackgroundOn") : t("ui.terminalBackgroundOff"),
          label: "ctrl+b",
        },
      ]}
    />
  )
}
