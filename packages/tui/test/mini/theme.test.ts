import { afterAll, beforeAll, expect, test } from "bun:test"
import path from "node:path"
import { RGBA, type CliRenderer, type TerminalColors } from "@opentui/core"
import { DEFAULT_THEME, resolveThemeDocument, type ResolvedTheme } from "@opencode-ai/theme/tui"
import {
  RUN_THEME_MONO,
  RUN_THEME_FALLBACK,
  RUN_THEME_FALLBACK_LIGHT,
  resolveRunTheme,
  type RunTheme,
} from "../../src/mini/theme"
import { DEFAULT_THEMES, parseTheme } from "../../src/theme"
import { tmpdir } from "../fixture/fixture"

const tmp = await tmpdir()
const previousConfig = process.env.OPENCODE_CONFIG_DIR
beforeAll(() => {
  process.env.OPENCODE_CONFIG_DIR = tmp.path
})
afterAll(async () => {
  if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousConfig
  await tmp[Symbol.asyncDispose]()
})

// REDSUN: mini follows the configured theme name; there is no generated system theme and no
// configured mode. "dusk" is the shipped default; "dawn" is its light sibling.
const DEFAULT = { dark: "dusk", light: "dawn" } as const
const NAMED = { dark: "gruvbox", light: "lotus" } as const

const palette = ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"] as const

function terminalColors(input: Partial<TerminalColors> = {}, mode: "light" | "dark" = "dark"): TerminalColors {
  return {
    palette: Array.from({ length: 256 }, (_, index) => palette[index % palette.length]!),
    defaultBackground: mode === "light" ? "#fbf1c7" : "#1a1b26",
    defaultForeground: mode === "light" ? "#3c3836" : "#c0caf5",
    cursorColor: "#ff9e64",
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: "#33467c",
    highlightForeground: "#c0caf5",
    ...input,
  }
}

const emptyColors = terminalColors({
  palette: Array.from({ length: 256 }, () => null),
  defaultBackground: null,
  defaultForeground: null,
  cursorColor: null,
  highlightBackground: null,
  highlightForeground: null,
})

function renderer(
  input: {
    themeMode?: "dark" | "light"
    resolvedThemeMode?: "dark" | "light"
    colors?: TerminalColors
    fail?: boolean
  } = {},
) {
  return {
    get themeMode() {
      return input.themeMode
    },
    waitForThemeMode: async () => input.resolvedThemeMode ?? input.themeMode ?? null,
    getPalette: async () => {
      if (input.fail) throw new Error("boom")
      return input.colors ?? terminalColors()
    },
  } as CliRenderer
}

function rgba(color: unknown) {
  expect(color).toBeInstanceOf(RGBA)
  if (!(color instanceof RGBA)) throw new Error("expected RGBA")
  return color
}

function expectFooter(actual: RunTheme, theme: ResolvedTheme) {
  const expected = {
    text: theme.text.default,
    muted: theme.text.subdued,
    warning: theme.text.feedback.warning.default,
    error: theme.text.feedback.error.default,
    actionSecondaryText: theme.contextual.elevated.text.action.secondary.default,
    actionFocusedBg: theme.contextual.elevated.background.action.primary.focused,
    actionFocusedText: theme.contextual.elevated.text.action.primary.focused,
    formfieldText: theme.contextual.elevated.text.formfield.default,
    formfieldFocusedBg: theme.contextual.elevated.background.formfield.focused,
    formfieldFocusedText: theme.contextual.elevated.text.formfield.focused,
    selection: theme.contextual.elevated.text.formfield.selected,
    running: theme.text.status.running,
    question: theme.text.status.question,
    permission: theme.text.status.permission,
    success: theme.text.feedback.success.default,
    link: theme.markdown.link,
    shade: theme.contextual.elevated.background.default,
    surface: theme.contextual.elevated.background.default,
    pane: theme.contextual.overlay.background.default,
    border: theme.border.default,
    line: theme.background.surface.overlay,
  }
  Object.entries(expected).forEach(([key, color]) => {
    expect(rgba(actual.footer[key as keyof typeof expected]).toInts()).toEqual(color.toInts())
  })
  expect(rgba(actual.background).intent).toBe("default")
}

const shipped = (name: string, mode: "dark" | "light") => resolveThemeDocument(parseTheme(DEFAULT_THEMES[name]!), mode)

test.each(["light", "dark"] as const)("preserves %s monochrome terminal defaults", async (mode) => {
  const theme = await resolveRunTheme(renderer({ fail: true, resolvedThemeMode: mode }), { name: "unknown" }, true)
  expect(theme.block.syntax).toBeUndefined()
  expect(rgba(theme.footer.text).toInts().slice(0, 3)).toEqual(mode === "light" ? [0, 0, 0] : [255, 255, 255])
  for (const color of [
    theme.background,
    ...Object.values(theme.footer).flat(),
    ...Object.values(theme.splash),
    ...Object.values(theme.entry).flatMap((tone) => [tone.body, tone.start].filter(Boolean)),
    ...Object.values(theme.block),
  ]) {
    expect(rgba(color).intent).toBe("default")
  }
  if (mode === "dark") expect(await resolveRunTheme(renderer(), undefined, true)).toBe(RUN_THEME_MONO)
  const term = renderer({ themeMode: mode })
  let queries = 0
  term.getPalette = async () => {
    queries++
    return terminalColors()
  }
  expect(await resolveRunTheme(term, undefined, true)).toBe(theme)
  expect(queries).toBe(0)
})

test.each(["light", "dark"] as const)("uses the shipped %s default and named built-in themes", async (mode) => {
  const colors = terminalColors({}, mode)
  for (const name of [undefined, DEFAULT[mode], NAMED[mode]] as const) {
    const theme = await resolveRunTheme(renderer({ colors }), { name })
    const expected = shipped(name ?? DEFAULT[mode], mode)
    try {
      expectFooter(theme, expected)
      expect(rgba(theme.background).toInts()).toEqual(RGBA.fromHex(colors.defaultBackground!).toInts())
      // Snapped palettes repeat colours across categorical slots; mini dedupes them.
      expect(theme.footer.categorical.map((color) => rgba(color).toInts())).toEqual(
        expected.categorical
          .map((scale) => scale[mode === "light" ? 800 : 200].toInts())
          .filter((ints, index, all) => all.findIndex((other) => String(other) === String(ints)) === index),
      )
      expect(theme.block.syntax?.getAllStyles().size).toBeGreaterThan(0)
      for (const color of [
        theme.entry.user.body,
        theme.entry.assistant.body,
        theme.block.text,
        ...Object.values(theme.splash),
      ]) {
        expect(rgba(color).intent).toBe("indexed")
        expect(rgba(color).slot).toBeLessThan(256)
      }
      expect(rgba(theme.footer.text).intent).toBe("rgb")
      for (const style of theme.block.syntax!.getAllStyles().values()) {
        if (style.fg && style.fg.a !== 0) expect(style.fg.intent).toBe("indexed")
        if (style.bg && style.bg.a !== 0) expect(style.bg.intent).toBe("indexed")
      }
    } finally {
      theme.block.syntax?.destroy()
    }
  }
})

test.each(["light", "dark"] as const)(
  "loads %s custom files with shared partial and standalone fallback",
  async (mode) => {
    for (const standalone of [false, true]) {
      const source = {
        version: 2,
        standalone,
        [mode]: {
          hue: DEFAULT_THEME[mode].hue,
          text: {
            default: "#123456",
            formfield: { default: "#234567", $selected: "#345678" },
            feedback: { warning: { default: "#456789" } },
          },
          "@context:elevated": {
            text: { action: { primary: { $focused: "#56789a" } }, formfield: { $focused: "#6789ab" } },
            background: { action: { primary: { $focused: "#789abc" } }, formfield: { $focused: "#89abcd" } },
          },
        },
      }
      await Bun.write(path.join(tmp.path, "themes", "mini-custom.json"), JSON.stringify(source))
      const theme = await resolveRunTheme(renderer({ colors: terminalColors({}, mode) }), { name: "mini-custom" })
      try {
        expectFooter(theme, resolveThemeDocument(parseTheme(source), mode))
      } finally {
        theme.block.syntax?.destroy()
      }
    }
  },
)

test.each(["light", "dark"] as const)(
  "falls back to the shipped %s default for unknown or invalid themes",
  async (mode) => {
    const expected = shipped(DEFAULT[mode], mode)
    for (const source of [
      { version: 2, [mode]: { categorical: [] } },
      { version: 2, [mode]: { text: { default: "$missing" } } },
      undefined,
    ]) {
      if (source) await Bun.write(path.join(tmp.path, "themes", "mini-invalid.json"), JSON.stringify(source))
      const theme = await resolveRunTheme(renderer({ colors: terminalColors({}, mode) }), {
        name: source ? "mini-invalid" : "mini-unknown",
      })
      try {
        expectFooter(theme, expected)
      } finally {
        theme.block.syntax?.destroy()
      }
    }
  },
)

test.each(["light", "dark"] as const)(
  "falls back only for unsupported modes of a %s-only custom theme",
  async (mode) => {
    const source = { version: 2, [mode]: { text: { default: "#123456" } } }
    await Bun.write(path.join(tmp.path, "themes", "mini-one-mode.json"), JSON.stringify(source))
    for (const requested of ["light", "dark"] as const) {
      const theme = await resolveRunTheme(renderer({ colors: terminalColors({}, requested) }), {
        name: "mini-one-mode",
      })
      try {
        expectFooter(
          theme,
          requested === mode ? resolveThemeDocument(parseTheme(source), requested) : shipped(DEFAULT[requested], requested),
        )
      } finally {
        theme.block.syntax?.destroy()
      }
    }
  },
)

test.each(["light", "dark"] as const)("handles unavailable palettes in %s mode", async (mode) => {
  const expected = shipped(DEFAULT[mode], mode)
  for (const input of [
    { fail: true, themeMode: mode },
    { colors: emptyColors, themeMode: mode },
    { colors: { ...emptyColors, defaultBackground: terminalColors({}, mode).defaultBackground } },
    { colors: { ...emptyColors, defaultForeground: terminalColors({}, mode).defaultForeground }, themeMode: mode },
  ]) {
    const theme = await resolveRunTheme(renderer(input), { name: DEFAULT[mode] })
    try {
      expectFooter(theme, expected)
    } finally {
      theme.block.syntax?.destroy()
    }
  }
  expect(RUN_THEME_FALLBACK).toBeDefined()
  expect(RUN_THEME_FALLBACK_LIGHT).toBeDefined()
})

test("uses refreshed background brightness rather than stale mode or ANSI slot zero", async () => {
  for (const colors of [
    terminalColors({}, "light"),
    terminalColors({ defaultBackground: null, palette: ["#000000", ...terminalColors().palette.slice(1)] }),
  ]) {
    const theme = await resolveRunTheme(renderer({ themeMode: colors.defaultBackground ? "dark" : "light", colors }), {
      name: "dawn",
    })
    try {
      expectFooter(theme, shipped("dawn", "light"))
    } finally {
      theme.block.syntax?.destroy()
    }
  }
})

test("follows the selected theme's own mode when the terminal reports none", async () => {
  for (const name of ["dusk", "dawn"] as const) {
    const theme = await resolveRunTheme(renderer({ colors: emptyColors }), { name })
    try {
      expectFooter(theme, shipped(name, name === "dawn" ? "light" : "dark"))
    } finally {
      theme.block.syntax?.destroy()
    }
  }
})

test("retains and refreshes the scrollback palette across probe failures", async () => {
  const input = { fail: false, colors: terminalColors() }
  const term = renderer(input)
  const initial = await resolveRunTheme(term, { name: "dusk" })
  input.fail = true
  const retained = await resolveRunTheme(term, { name: "dusk" })
  input.fail = false
  input.colors = terminalColors({ palette: Array.from({ length: 256 }, () => "#ff00ff") })
  const refreshed = await resolveRunTheme(term, { name: "dusk" })
  try {
    expect(rgba(retained.footer.surface).toInts()).toEqual(rgba(initial.footer.surface).toInts())
    expect(rgba(retained.entry.reasoning.body).toInts()).toEqual(rgba(initial.entry.reasoning.body).toInts())
    expect(rgba(refreshed.entry.reasoning.body).toInts()).not.toEqual(rgba(initial.entry.reasoning.body).toInts())
  } finally {
    initial.block.syntax?.destroy()
    retained.block.syntax?.destroy()
    refreshed.block.syntax?.destroy()
  }
})
