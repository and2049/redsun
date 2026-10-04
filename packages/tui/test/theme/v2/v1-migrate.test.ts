import { expect, test } from "bun:test"
import {
  migrateV1,
  resolveThemeDocument,
  selectThemeMode,
  themeModes,
  type HueScale,
  type ResolvedTheme,
} from "@opencode/theme/tui"
import { DEFAULT_THEMES, resolveTheme as resolveV1 } from "../../../src/theme"
import { v1Theme } from "../../fixture/fixture"
import { getOpenCodeTheme } from "../../fixture/opencode-v2-theme"
import { RGBA } from "@opentui/core"
import { parseTheme } from "../../../src/theme"
import dusk from "../../../../theme/src/tui/assets/dusk.json" with { type: "json" }

test("migrates resolved V1 modes into V2 tokens", () => {
  const migrated = migrateV1(v1Theme())
  if (!migrated.light || !migrated.dark) throw new Error("Expected both modes")
  const legacy = resolveV1(v1Theme(), "light")
  const resolved = resolveThemeDocument(migrated, "light")

  expect(migrated.base.categorical?.length).toBeGreaterThan(0)
  expect(migrated.dark.categorical?.length).toBeGreaterThan(0)
  expect(migrated.light.hue?.accent).toMatch(/^\$hue\.[^.]+$/)
  expect(migrated.light.hue?.interactive).toMatch(/^\$hue\.[^.]+$/)
  // Hue steps run the same way in both modes: 200 is the text side, 800 the background.
  expect(migrated.base.text?.base).toBe("$hue.neutral.200")
  expect(migrated.base.text?.muted).toBe("$hue.neutral.400")
  expect(migrated.base.background?.action?.primary?.base).toBe("transparent")
  expect(migrated.base.background?.base).toBe("$hue.neutral.800")
  expect(migrated.base.background?.raised?.base).toBe("$hue.neutral.700")
  expect(migrated.base.background?.raised?.high).toBe("$hue.neutral.600")
  expect(migrated.dark.background?.base).toBe("$hue.neutral.800")
  expect(migrated.dark.background?.raised?.base).toBe("$hue.neutral.700")
  expect(migrated.dark.background?.raised?.high).toBe("$hue.neutral.600")
  expect(migrated.base.text?.action?.primary?.base).toBe("$text.base")
  expect(migrated.base.text?.action?.secondary?.base).toBe("$text.muted")
  expect(migrated.base.text?.action?.secondary?.$hovered).toBe("$text.base")
  expect(migrated.base.background?.action?.primary?.$selected).toBe("transparent")
  expect(resolved.background.raised.base.toInts()).toEqual(legacy.backgroundPanel.toInts())
  expect(resolved.background.raised.high.toInts()).toEqual(legacy.backgroundElement.toInts())
  expect(resolved.background.formfield.selected.toInts()).toEqual(legacy.background.toInts())
  expect(resolved.background.formfield.focused.toInts()).toEqual(legacy.background.toInts())
  expect(resolved.text.formfield.base.toInts()).toEqual(legacy.text.toInts())
  expect(resolved.text.formfield.selected.toInts()).toEqual(legacy.primary.toInts())
  expect(resolved.text.formfield.focused.toInts()).toEqual(legacy.primary.toInts())
  expect(resolved.hue.accent[200].toInts()).toEqual(legacy.accent.toInts())
  expect(resolved.hue.interactive[200].toInts()).toEqual(legacy.primary.toInts())
  expect(resolved.background.action.primary.selected.toInts()).toEqual([0, 0, 0, 0])
  expect(resolved.text.action.primary.selected.toInts()).toEqual(legacy.primary.toInts())
  expect(resolved.text.action.secondary.base.toInts()).toEqual(legacy.textMuted.toInts())
  expect(resolved.text.action.secondary.hovered.toInts()).toEqual(legacy.text.toInts())
  expect(resolved.background.feedback.error.base.toInts()).toEqual(legacy.background.toInts())
  expect(resolved.surface("dialog").background.base.toInts()).toEqual(legacy.backgroundPanel.toInts())
  expect(resolved.surface("dialog").background.action.primary.base.toInts()).toEqual([0, 0, 0, 0])
  expect(resolved.surface("dialog").text.action.primary.base.toInts()).toEqual(legacy.text.toInts())
})

test("references generated hues from matching token colors", () => {
  const source = v1Theme()
  source.theme.border = source.theme.primary
  source.theme.borderActive = source.theme.accent
  source.theme.syntaxKeyword = source.theme.error
  source.theme.markdownEmph = "#123456"

  const migrated = migrateV1(source)
  if (!migrated.light) throw new Error("Expected light mode")

  expect(migrated.base.border?.base).toBe("$hue.interactive.200")
  expect(migrated.base.scrollbar?.base).toBe("$hue.accent.200")
  expect(migrated.base.syntax?.keyword).toMatch(/^\$hue\.[^.]+\.200$/)
  expect(migrated.base.markdown?.emphasis).toBe("#123456")
})

test("infers chromatic hues, pins them to the declared colour, and omits ambiguous hues", () => {
  const source = v1Theme()
  const ambiguous = { light: "#808080", dark: "#808080" }
  source.theme.accent = ambiguous
  source.theme.warning = ambiguous
  source.theme.primary = ambiguous
  source.theme.error = ambiguous
  source.theme.info = ambiguous
  source.theme.secondary = "transparent"
  source.theme.success = { light: "#ff6666", dark: "#450000" }

  const migrated = migrateV1(source)
  if (!migrated.light || !migrated.dark) throw new Error("Expected both modes")
  const lightRed = migrated.light.hue?.red
  const darkRed = migrated.dark.hue?.red
  if (typeof lightRed !== "object" || typeof darkRed !== "object") throw new Error("Expected generated red scales")

  // A chromatic hue declares exactly one colour, so every step answers with it
  // rather than an interpolation the theme never named.
  expect(lightRed[200]).toBe("#ff6666")
  expect(darkRed[200]).toBe("#450000")
  expect(new Set(Object.values(lightRed))).toEqual(new Set(["#ff6666"]))
  expect(new Set(Object.values(darkRed))).toEqual(new Set(["#450000"]))
  expect(migrated.light.hue?.orange).toBeUndefined()
  expect(migrated.light.hue?.yellow).toBeUndefined()
  expect(migrated.light.hue?.green).toBeUndefined()
  expect(migrated.light.hue?.cyan).toBeUndefined()
  expect(migrated.light.hue?.blue).toBeUndefined()
  expect(migrated.light.hue?.purple).toBeUndefined()
  expect(migrated.light.hue?.accent).toBe("$hue.gray")
  expect(migrated.light.hue?.interactive).toBe("$hue.gray")
  expect(() => resolveThemeDocument(migrated, "light")).not.toThrow()
  expect(() => resolveThemeDocument(migrated, "dark")).not.toThrow()
})

test("carries the seven V1 semantic colors into categorical, in order and undeduped", () => {
  // V1 handed agents colours from this list by index. Rounding each to its
  // nearest hue merged `secondary` with `warning` in most themes and cost two
  // distinct agent colours, so the literal shades are kept instead.
  const source = v1Theme()
  source.theme.secondary = "#aa00ff"
  source.theme.accent = "#ff8800"
  source.theme.success = "#00aa44"
  source.theme.warning = "#ffcc00"
  source.theme.primary = "#0066ff"
  source.theme.error = "#ff0033"
  source.theme.info = "#00cccc"

  const expected = ["#aa00ff", "#ff8800", "#00aa44", "#ffcc00", "#0066ff", "#ff0033", "#00cccc"]
  const migrated = migrateV1(source)
  expect(migrated.base.categorical).toEqual(expected)
  expect(migrated.dark?.categorical).toEqual(expected)

  // Two V1 tokens naming the same colour stay two entries: the index a given
  // agent lands on is part of the palette V1 shipped.
  source.theme.accent = source.theme.secondary
  expect(migrateV1(source).base.categorical).toEqual([
    "#aa00ff",
    "#aa00ff",
    "#00aa44",
    "#ffcc00",
    "#0066ff",
    "#ff0033",
    "#00cccc",
  ])
})

test("drops transparent semantic colors from categorical", () => {
  const source = v1Theme()
  source.theme.secondary = "transparent"
  source.theme.accent = "#ff8800"

  const categorical = migrateV1(source).base.categorical
  expect(categorical?.includes("#00000000")).toBe(false)
  expect(categorical?.[0]).toBe("#ff8800")
})

test("gives accent and primary ownership of their inferred hues", () => {
  const source = v1Theme()
  const reference = { hue: allHues(resolveThemeDocument(getOpenCodeTheme(), "light")) }
  source.theme.success = hex(reference.hue.orange[700])
  source.theme.accent = hex(reference.hue.orange[600])
  source.theme.info = hex(reference.hue.blue[700])
  source.theme.primary = hex(reference.hue.blue[600])

  const migrated = migrateV1(source)
  if (!migrated.light) throw new Error("Expected light mode")
  const orange = migrated.light.hue?.orange
  const blue = migrated.light.hue?.blue
  if (typeof orange !== "object" || typeof blue !== "object") throw new Error("Expected concrete hue scales")

  expect(orange[200]).toBe(source.theme.accent)
  expect(blue[200]).toBe(source.theme.primary)
  expect(migrated.light.hue?.accent).toBe("$hue.orange")
  expect(migrated.light.hue?.interactive).toBe("$hue.blue")

  source.theme.primary = hex(reference.hue.orange[500])
  const collisionMode = migrateV1(source).light
  const collision = collisionMode?.hue?.orange
  if (typeof collision !== "object") throw new Error("Expected concrete orange scale")
  expect(collision[200]).toBe(source.theme.primary)
  expect(collisionMode?.hue?.accent).toBe("$hue.orange")
  expect(collisionMode?.hue?.interactive).toBe("$hue.orange")
})

test("uses the semantic neutral hue when V1 categorical colors are ambiguous", () => {
  const source = v1Theme()
  source.theme.secondary = "transparent"
  source.theme.accent = "transparent"
  source.theme.success = "transparent"
  source.theme.warning = "transparent"
  source.theme.primary = "transparent"
  source.theme.error = "transparent"
  source.theme.info = "transparent"

  const migrated = migrateV1(source)
  expect(migrated.base.categorical).toEqual(["neutral"])
  expect(migrated.dark?.categorical).toEqual(["neutral"])
})

test("builds gray from V1 surfaces and text without using menus or borders", () => {
  const source = v1Theme()
  source.theme.background = { light: "#eeeeee", dark: "#111111" }
  source.theme.backgroundPanel = { light: "#dddddd", dark: "#222222" }
  source.theme.backgroundElement = { light: "#cccccc", dark: "#333333" }
  source.theme.textMuted = { light: "#777777", dark: "#999999" }
  source.theme.text = { light: "#333333", dark: "#dddddd" }
  source.theme.backgroundMenu = { light: "#ededed", dark: "#252525" }
  const light = resolveV1(source, "light")
  const dark = resolveV1(source, "dark")
  const migrated = migrateV1(source)
  if (!migrated.light || !migrated.dark) throw new Error("Expected both modes")
  const lightGray = migrated.light.hue?.gray
  const darkGray = migrated.dark.hue?.gray
  if (typeof lightGray !== "object" || typeof darkGray !== "object") throw new Error("Expected concrete gray scales")

  // Five steps per mode are the colours the file names; the other four take the
  // nearest anchor at or below them, so no step invents a shade. Both modes
  // run text-side (200) to background-side (800).
  expect(lightGray[200]).toBe(hex(light.text))
  expect(lightGray[400]).toBe(hex(light.textMuted))
  expect(lightGray[600]).toBe(hex(light.backgroundElement))
  expect(lightGray[700]).toBe(hex(light.backgroundPanel))
  expect(lightGray[800]).toBe(hex(light.background))
  expect(lightGray[100]).toBe(lightGray[200])
  expect(lightGray[300]).toBe(lightGray[200])
  expect(lightGray[500]).toBe(lightGray[400])
  expect(lightGray[900]).toBe(lightGray[800])
  expect(darkGray[200]).toBe(hex(dark.text))
  expect(darkGray[400]).toBe(hex(dark.textMuted))
  expect(darkGray[600]).toBe(hex(dark.backgroundElement))
  expect(darkGray[700]).toBe(hex(dark.backgroundPanel))
  expect(darkGray[800]).toBe(hex(dark.background))
  expect(darkGray[100]).toBe(darkGray[200])
  expect(darkGray[300]).toBe(darkGray[200])
  expect(darkGray[500]).toBe(darkGray[400])
  expect(darkGray[900]).toBe(darkGray[800])

  source.theme.borderSubtle = "#ff00ff"
  source.theme.border = "#00ff00"
  source.theme.borderActive = "#00ffff"
  const withBorders = migrateV1(source)
  expect(withBorders.light?.hue?.gray).toEqual(lightGray)
  expect(withBorders.dark?.hue?.gray).toEqual(darkGray)
})

test("uses the base text reference for primary actions on transparent backgrounds", () => {
  const source = v1Theme()
  source.theme.background = "transparent"
  source.theme.primary = { light: "#ffffff", dark: "#000000" }
  delete source.theme.selectedListItemText
  const migrated = migrateV1(source)
  if (!migrated.light || !migrated.dark) throw new Error("Expected both modes")

  expect(migrated.base.text?.action?.primary?.base).toBe("$text.base")
  expect(migrated.dark.text?.action?.primary?.base).toBe("$text.base")
})

test("retains V1 circular reference errors", () => {
  const source = v1Theme()
  source.defs = { ...source.defs, one: "two", two: "one" }
  source.theme.primary = "one"

  expect(() => migrateV1(source)).toThrow("Circular color reference: one -> two -> one")
})

test("migrates a V1 theme in every mode it supports", () => {
  const migrated = migrateV1(v1Theme())
  const modes = themeModes(migrated)
  expect(modes.length).toBeGreaterThan(0)
  for (const mode of modes) {
    expect(resolveThemeDocument(migrated, mode).text.base).toBeDefined()
  }
})

test("migrates every built-in V1 theme in its supported modes", () => {
  for (const source of Object.values(DEFAULT_THEMES)) {
    const migrated = migrateV1(source as never)
    for (const mode of themeModes(migrated)) {
      expect(resolveThemeDocument(migrated, mode).text.base).toBeDefined()
    }
  }
})

test("collapses identical V1 backgrounds when both variants infer one mode", () => {
  const dark = v1Theme()
  dark.theme.background = "#111111"
  dark.theme.text = "#eeeeee"
  const migratedDark = migrateV1(dark)
  expect(migratedDark.light).toBeUndefined()
  expect(migratedDark.dark).toBeDefined()
  expect(themeModes(migratedDark)).toEqual(["dark"])
  expect(selectThemeMode(migratedDark, "light").mode).toBe("dark")

  const light = v1Theme()
  light.theme.background = "#eeeeee"
  light.theme.text = "#111111"
  const migratedLight = migrateV1(light)
  expect(migratedLight.light).toBeDefined()
  expect(migratedLight.dark).toBeUndefined()
  expect(themeModes(migratedLight)).toEqual(["light"])
  expect(selectThemeMode(migratedLight, "dark").mode).toBe("light")
})

test("keeps both modes when a shared background has different contrast", () => {
  const source = v1Theme()
  source.theme.background = "#808080"
  source.theme.text = { light: "#111111", dark: "#eeeeee" }
  const migrated = migrateV1(source)

  expect(themeModes(migrated)).toEqual(["light", "dark"])
})

function allHues(theme: ResolvedTheme) {
  return theme.hue as typeof theme.hue & Readonly<Record<string, HueScale>>
}

function hex(color: { toInts(): [number, number, number, number] }) {
  const [r, g, b, a] = color.toInts()
  const byte = (value: number) => value.toString(16).padStart(2, "0")
  return `#${byte(r)}${byte(g)}${byte(b)}${a === 255 ? "" : byte(a)}`
}

test("carries the redsun wordmark gradient across, and omits it when absent", () => {
  // Upstream V1 has no gradient token, so a theme without one must not invent
  // a `logo` block -- it should inherit the resolver's default.
  const source = v1Theme()
  expect(migrateV1(source).base.logo).toBeUndefined()
  expect(resolveThemeDocument(migrateV1(source), "light").logo.gradient.start).toBeDefined()

  source.theme.logoGradientStart = "#f8cb00"
  source.theme.logoGradientEnd = "#c3133c"
  const migrated = migrateV1(source)
  expect(migrated.base.logo?.gradient?.start).toBe("#f8cb00")
  expect(migrated.base.logo?.gradient?.end).toBe("#c3133c")

  const resolved = resolveThemeDocument(migrated, "light")
  expect(resolved.logo.gradient.start.equals(RGBA.fromHex("#f8cb00"))).toBeTrue()
  expect(resolved.logo.gradient.end.equals(RGBA.fromHex("#c3133c"))).toBeTrue()
})

test("dusk resolves to the same tokens the generated V2 document did", () => {
  // The shipped assets went back to V1's flat palette; this is the guard that
  // the format change is a no-op on appearance. The right-hand values are the
  // hues the generated `dusk` document spelled out (`neutral.200/400/600/700/800`).
  const resolved = resolveThemeDocument(parseTheme(dusk, "dusk"), "dark")
  const hex = (color: RGBA) => {
    const [r, g, b, a] = color.toInts()
    const byte = (value: number) => value.toString(16).padStart(2, "0")
    return `#${byte(r)}${byte(g)}${byte(b)}${a === 255 ? "" : byte(a)}`
  }

  expect(hex(resolved.text.base)).toBe("#e4e4e4")
  expect(hex(resolved.text.muted)).toBe("#e4e4e45e")
  expect(hex(resolved.background.base)).toBe("#181717")
  expect(hex(resolved.background.raised.base)).toBe("#242222")
  expect(hex(resolved.background.raised.high)).toBe("#242222")
  expect(hex(resolved.border.base)).toBe("#e4e4e438")
  expect(hex(resolved.logo.gradient.start)).toBe("#f8cb00")
  expect(hex(resolved.logo.gradient.end)).toBe("#c3133c")
  // V1's seven agent colours, in order, unrounded.
  expect(resolved.categorical.map((scale) => hex(scale[200]))).toEqual([
    "#ee9a62",
    "#fde36f",
    "#8fb458",
    "#f1b467",
    "#fde36f",
    "#e34671",
    "#ee9a62",
  ])
})
