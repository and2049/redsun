import { RGBA, SyntaxStyle, type CliRenderer, type ColorInput, type TerminalColors } from "@opentui/core"
import { generateSyntax, resolveThemeDocument, themeModes, type ResolvedTheme } from "@opencode-ai/theme/tui"
import { allThemes, DEFAULT_THEMES, isThemeSource, parseTheme, themeMode, type ThemeDocumentSource } from "../theme"
import { ansiToRgba } from "../theme/color"
import { discoverThemes } from "../theme/discovery"
import { terminalMode } from "../theme/system"
import { configDirectories } from "../util/config-directories"
import { dedupeWith } from "effect/Array"
import type { EntryKind, RunTuiConfig } from "./types"

// REDSUN: mini follows the configured theme name like the full TUI; there is no
// generated "system" theme and no configured mode, so the mode comes from the
// terminal when it reports one and from the theme document otherwise.
const DEFAULT_THEME_NAME = "dusk"
const DEFAULT_THEME_BY_MODE = { dark: "dusk", light: "dawn" } as const

type Tone = {
  body: ColorInput
  start?: ColorInput
}

export type RunEntryTheme = Record<EntryKind, Tone>

export type RunSplashTheme = {
  left: ColorInput
  right: ColorInput
  leftShadow: ColorInput
}

export type RunFooterTheme = {
  actionSecondaryText: ColorInput
  actionFocusedBg: ColorInput
  actionFocusedText: ColorInput
  formfieldText: ColorInput
  formfieldFocusedBg: ColorInput
  formfieldFocusedText: ColorInput
  selection: ColorInput
  running: ColorInput
  question: ColorInput
  permission: ColorInput
  success: ColorInput
  link: ColorInput
  categorical: ColorInput[]
  warning: ColorInput
  error: ColorInput
  muted: ColorInput
  text: ColorInput
  shade: ColorInput
  surface: ColorInput
  pane: ColorInput
  border: ColorInput
  line: ColorInput
}

export type RunBlockTheme = {
  text: ColorInput
  muted: ColorInput
  syntax?: SyntaxStyle
  diffRemoved: ColorInput
  diffAddedBg: ColorInput
  diffRemovedBg: ColorInput
  diffContextBg: ColorInput
  diffHighlightAdded: ColorInput
  diffHighlightRemoved: ColorInput
  diffLineNumber: ColorInput
  diffAddedLineNumberBg: ColorInput
  diffRemovedLineNumberBg: ColorInput
}

export type RunTheme = {
  background: ColorInput
  footer: RunFooterTheme
  entry: RunEntryTheme
  splash: RunSplashTheme
  block: RunBlockTheme
}

export const transparent = RGBA.fromValues(0, 0, 0, 0)

const ansiPalette = Array.from({ length: 256 }, (_, index) => RGBA.fromIndex(index, ansiToRgba(index)))
const palettes = new WeakMap<CliRenderer, TerminalColors>()

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function oklab(color: RGBA) {
  const r = srgbToLinear(color.r)
  const g = srgbToLinear(color.g)
  const b = srgbToLinear(color.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

function nearestIndexed(indexed: RGBA[], color: RGBA): RGBA {
  const target = oklab(color)
  const hit = indexed.reduce(
    (best, item) => {
      const sample = oklab(item)
      const dl = sample.l - target.l
      const da = sample.a - target.a
      const db = sample.b - target.b
      const dist = dl * dl * 2 + da * da + db * db
      return dist >= best.dist ? best : { dist, item }
    },
    { dist: Number.POSITIVE_INFINITY, item: indexed[0]! },
  )
  return RGBA.clone(hit.item)
}

function map(theme: ResolvedTheme, indexed: RGBA[], mode: "light" | "dark", syntax?: SyntaxStyle): RunTheme {
  const elevated = theme.contextual.elevated
  const scrollback = (color: RGBA) => (color.a === 0 || color.intent !== "rgb" ? color : nearestIndexed(indexed, color))
  syntax?.getAllStyles().forEach((style, name) => {
    syntax.registerStyle(name, {
      ...style,
      fg: style.fg && scrollback(style.fg),
      bg: style.bg && scrollback(style.bg),
    })
  })

  return {
    background: RGBA.defaultBackground(theme.background.default),
    footer: {
      actionSecondaryText: elevated.text.action.secondary.default,
      actionFocusedBg: elevated.background.action.primary.focused,
      actionFocusedText: elevated.text.action.primary.focused,
      formfieldText: elevated.text.formfield.default,
      formfieldFocusedBg: elevated.background.formfield.focused,
      formfieldFocusedText: elevated.text.formfield.focused,
      selection: elevated.text.formfield.selected,
      running: theme.text.status.running,
      question: theme.text.status.question,
      permission: theme.text.status.permission,
      success: theme.text.feedback.success.default,
      link: theme.markdown.link,
      categorical: dedupeWith(
        theme.categorical.map((scale) => scale[mode === "light" ? 800 : 200]),
        (a, b) => a.equals(b),
      ),
      warning: theme.text.feedback.warning.default,
      error: theme.text.feedback.error.default,
      muted: theme.text.subdued,
      text: theme.text.default,
      shade: elevated.background.default,
      surface: elevated.background.default,
      pane: theme.contextual.overlay.background.default,
      border: theme.border.default,
      line: theme.background.surface.overlay,
    },
    entry: {
      system: { body: scrollback(theme.text.subdued) },
      user: { body: scrollback(theme.text.default) },
      assistant: { body: scrollback(theme.markdown.text) },
      reasoning: { body: scrollback(theme.text.subdued) },
      tool: { body: scrollback(theme.text.subdued), start: scrollback(theme.text.subdued) },
      error: { body: scrollback(theme.text.feedback.error.default) },
    },
    splash: {
      left: nearestIndexed(indexed, theme.text.subdued),
      right: nearestIndexed(indexed, theme.text.default),
      leftShadow: nearestIndexed(indexed, theme.background.surface.offset),
    },
    block: {
      text: scrollback(theme.text.default),
      muted: scrollback(theme.text.subdued),
      syntax,
      diffRemoved: scrollback(theme.diff.text.removed),
      diffAddedBg: scrollback(theme.diff.background.added),
      diffRemovedBg: scrollback(theme.diff.background.removed),
      diffContextBg: scrollback(theme.diff.background.context),
      diffHighlightAdded: scrollback(theme.diff.highlight.added),
      diffHighlightRemoved: scrollback(theme.diff.highlight.removed),
      diffLineNumber: scrollback(theme.diff.lineNumber.text),
      diffAddedLineNumberBg: scrollback(theme.diff.lineNumber.background.added),
      diffRemovedLineNumberBg: scrollback(theme.diff.lineNumber.background.removed),
    },
  }
}

const fallbackDocument = (mode: "dark" | "light") =>
  parseTheme(DEFAULT_THEMES[DEFAULT_THEME_BY_MODE[mode]]!, DEFAULT_THEME_BY_MODE[mode])

export const RUN_THEME_FALLBACK = map(resolveThemeDocument(fallbackDocument("dark"), "dark"), ansiPalette, "dark")
export const RUN_THEME_FALLBACK_LIGHT = map(
  resolveThemeDocument(fallbackDocument("light"), "light"),
  ansiPalette,
  "light",
)

function monoTheme(mode: "dark" | "light"): RunTheme {
  const foreground = RGBA.defaultForeground(mode === "light" ? "#000000" : "#ffffff")
  const background = RGBA.defaultBackground(mode === "light" ? "#ffffff" : "#000000")
  return {
    background,
    footer: {
      actionSecondaryText: foreground,
      actionFocusedBg: background,
      actionFocusedText: foreground,
      formfieldText: foreground,
      formfieldFocusedBg: background,
      formfieldFocusedText: foreground,
      selection: foreground,
      running: foreground,
      question: foreground,
      permission: foreground,
      success: foreground,
      link: foreground,
      categorical: [foreground],
      warning: foreground,
      error: foreground,
      muted: foreground,
      text: foreground,
      shade: background,
      surface: background,
      pane: background,
      border: foreground,
      line: background,
    },
    entry: {
      system: { body: foreground },
      user: { body: foreground },
      assistant: { body: foreground },
      reasoning: { body: foreground },
      tool: { body: foreground },
      error: { body: foreground },
    },
    splash: { left: foreground, right: foreground, leftShadow: background },
    block: {
      text: foreground,
      muted: foreground,
      diffRemoved: foreground,
      diffAddedBg: background,
      diffRemovedBg: background,
      diffContextBg: background,
      diffHighlightAdded: foreground,
      diffHighlightRemoved: foreground,
      diffLineNumber: foreground,
      diffAddedLineNumberBg: background,
      diffRemovedLineNumberBg: background,
    },
  }
}

export const RUN_THEME_MONO = monoTheme("dark")
const RUN_THEME_MONO_LIGHT = monoTheme("light")

export async function resolveRunTheme(
  renderer: CliRenderer,
  config?: RunTuiConfig["theme"],
  mono = false,
): Promise<RunTheme> {
  if (mono) {
    const mode = renderer.themeMode ?? (await renderer.waitForThemeMode(300))
    return mode === "light" ? RUN_THEME_MONO_LIGHT : RUN_THEME_MONO
  }

  const detected = await renderer.getPalette({ size: 256 }).catch(() => undefined)
  // A transient OSC timeout must not remap immutable scrollback against an unrelated ANSI palette.
  const colors =
    (detected?.defaultBackground ?? detected?.palette[0]) && (detected?.defaultForeground ?? detected?.palette[7])
      ? detected
      : palettes.get(renderer)
  if (colors) palettes.set(renderer, colors)
  const name = config?.name ?? DEFAULT_THEME_NAME
  // Mini stays transparent: fresh OSC 11 wins, but cached colors must not override a new renderer mode.
  const detectedMode = (detected && terminalMode(detected)) ?? renderer.themeMode ?? (colors && terminalMode(colors))
  const fallback = (mode: "dark" | "light") => (mode === "light" ? RUN_THEME_FALLBACK_LIGHT : RUN_THEME_FALLBACK)
  // The default theme needs no discovery, so a mode flip repaints before the next render pass.
  if (!colors && name === DEFAULT_THEME_NAME) return fallback(detectedMode ?? "dark")
  const source = await themeSource(name)
  const mode = detectedMode ?? themeMode(source, name)
  if (!colors && source === DEFAULT_THEMES[DEFAULT_THEME_NAME]) return fallback(mode)

  const resolved = (() => {
    try {
      const document = parseTheme(source, name)
      // Mini keeps the terminal background, so the opposite theme mode is not a safe fallback.
      if (themeModes(document).includes(mode)) return resolveThemeDocument(document, mode)
    } catch {
      return undefined
    }
  })()
  const theme = resolved ?? resolveThemeDocument(fallbackDocument(mode), mode)
  const indexed = colors
    ? ansiPalette.map((color, index) => (colors.palette[index] ? RGBA.fromIndex(index, colors.palette[index]!) : color))
    : ansiPalette
  return {
    ...map(theme, indexed, mode, generateSyntax(theme, mode)),
    background: RGBA.defaultBackground(colors?.defaultBackground ?? theme.background.default),
  }
}

async function themeSource(name: string): Promise<ThemeDocumentSource> {
  const { Global } = await import("@opencode-ai/util/global")
  const custom = await discoverThemes(
    configDirectories(process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config, process.cwd()),
  )
  const source = custom[name] ?? allThemes()[name] ?? DEFAULT_THEMES[DEFAULT_THEME_NAME]!
  return isThemeSource(source) ? source : DEFAULT_THEMES[DEFAULT_THEME_NAME]!
}
