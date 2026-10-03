import { RGBA } from "@opentui/core"

export type Theme = {
  readonly logoGradientStart: RGBA
  readonly logoGradientEnd: RGBA
  readonly primary: RGBA
  readonly secondary: RGBA
  readonly accent: RGBA
  readonly error: RGBA
  readonly warning: RGBA
  readonly success: RGBA
  readonly info: RGBA
  readonly text: RGBA
  readonly textMuted: RGBA
  readonly selectedListItemText: RGBA
  readonly background: RGBA
  readonly backgroundPanel: RGBA
  // Derived, not declared: element surfaces reuse the panel colour.
  readonly backgroundElement: RGBA
  readonly backgroundMenu: RGBA
  readonly border: RGBA
  readonly borderActive: RGBA
  readonly borderSubtle: RGBA
  readonly diffAdded: RGBA
  readonly diffRemoved: RGBA
  readonly diffContext: RGBA
  readonly diffHunkHeader: RGBA
  readonly diffHighlightAdded: RGBA
  readonly diffHighlightRemoved: RGBA
  // Derived, not declared: diff row highlights are `diffAdded`/`diffRemoved`
  // at 20% alpha, and the line-number gutter shares them.
  readonly diffAddedBg: RGBA
  readonly diffRemovedBg: RGBA
  readonly diffContextBg: RGBA
  readonly diffLineNumber: RGBA
  readonly diffAddedLineNumberBg: RGBA
  readonly diffRemovedLineNumberBg: RGBA
  readonly markdownText: RGBA
  readonly markdownHeading: RGBA
  readonly markdownLink: RGBA
  readonly markdownLinkText: RGBA
  readonly markdownCode: RGBA
  readonly markdownBlockQuote: RGBA
  readonly markdownEmph: RGBA
  readonly markdownStrong: RGBA
  readonly markdownHorizontalRule: RGBA
  readonly markdownListItem: RGBA
  readonly markdownListEnumeration: RGBA
  readonly markdownImage: RGBA
  readonly markdownImageText: RGBA
  readonly markdownCodeBlock: RGBA
  readonly syntaxComment: RGBA
  readonly syntaxKeyword: RGBA
  readonly syntaxFunction: RGBA
  readonly syntaxVariable: RGBA
  readonly syntaxString: RGBA
  readonly syntaxNumber: RGBA
  readonly syntaxType: RGBA
  readonly syntaxOperator: RGBA
  readonly syntaxPunctuation: RGBA
  // Redsun tokens: explicit colours for the primary agent modes; absent keys
  // fall back to the positional categorical assignment.
  readonly agentBuild?: RGBA
  readonly agentPlan?: RGBA
  readonly agentCompose?: RGBA
  readonly thinkingOpacity: number
  _hasSelectedListItemText: boolean
}

export type ThemeColor = Exclude<
  keyof Theme,
  | "thinkingOpacity"
  | "_hasSelectedListItemText"
  | "agentBuild"
  | "agentPlan"
  | "agentCompose"
  | "diffAddedBg"
  | "diffRemovedBg"
  | "diffAddedLineNumberBg"
  | "diffRemovedLineNumberBg"
  | "diffContextBg"
  | "backgroundElement"
>
// The syntax table and the selected-foreground rule never read the wordmark
// gradient, so they accept the plugin-facing theme surface too.
export type SyntaxTheme = Omit<Theme, "logoGradientStart" | "logoGradientEnd">
export type ThemeMode = "dark" | "light"
export type HexColor = `#${string}`
export type RefName = string
export type Variant = {
  dark: HexColor | RefName
  light: HexColor | RefName
}
export type ColorValue = HexColor | RefName | Variant | RGBA | number
export type ThemeV1Json = {
  $schema?: string
  // A theme declares which half of the picker it belongs to. Themes that omit
  // it are classified by text/background contrast, which disagrees for exactly
  // one shipped theme (`wave` declares light but paints light text on
  // mid-blue) -- the declaration wins there.
  mode?: ThemeMode
  defs?: Record<string, HexColor | RefName>
  theme: Omit<
    Record<ThemeColor, ColorValue>,
    "logoGradientStart" | "logoGradientEnd" | "selectedListItemText" | "backgroundMenu"
  > & {
    // Ignored if declared: these four are always derived from
    // `diffAdded`/`diffRemoved` (upstream V1 themes may still carry them).
    diffAddedBg?: ColorValue
    diffRemovedBg?: ColorValue
    diffAddedLineNumberBg?: ColorValue
    diffRemovedLineNumberBg?: ColorValue
    diffContextBg?: ColorValue
    backgroundElement?: ColorValue
    // Redsun tokens; upstream V1 themes have no wordmark gradient.
    logoGradientStart?: ColorValue
    logoGradientEnd?: ColorValue
    selectedListItemText?: ColorValue
    backgroundMenu?: ColorValue
    agentBuild?: ColorValue
    agentPlan?: ColorValue
    agentCompose?: ColorValue
    thinkingOpacity?: number
  }
}

export function ansiToRgba(code: number): RGBA {
  if (code < 16) {
    const colors = [
      "#000000",
      "#800000",
      "#008000",
      "#808000",
      "#000080",
      "#800080",
      "#008080",
      "#c0c0c0",
      "#808080",
      "#ff0000",
      "#00ff00",
      "#ffff00",
      "#0000ff",
      "#ff00ff",
      "#00ffff",
      "#ffffff",
    ]
    return RGBA.fromHex(colors[code] ?? "#000000")
  }
  if (code < 232) {
    const index = code - 16
    const value = (part: number) => (part === 0 ? 0 : part * 40 + 55)
    return RGBA.fromInts(value(Math.floor(index / 36)), value(Math.floor(index / 6) % 6), value(index % 6))
  }
  if (code < 256) {
    const gray = (code - 232) * 10 + 8
    return RGBA.fromInts(gray, gray, gray)
  }
  return RGBA.fromInts(0, 0, 0)
}

const DIFF_HIGHLIGHT_ALPHA = 0.2

function diffHighlightBg(color: RGBA) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * DIFF_HIGHLIGHT_ALPHA)
}

// The one V1 resolver: walks defs, mode forks and ANSI codes, then applies the
// derivations the flat format leans on (selection fallback, panel-backed
// surfaces, diff washes). Both the V2 migration and the mini renderer resolve
// through here, so the derivations can never drift between them.
export function resolveV1(
  theme: ThemeV1Json,
  mode: "dark" | "light",
  resolveAnsi: (code: number) => RGBA = ansiToRgba,
): Theme {
  const defs = theme.defs ?? {}

  function resolveColor(value: unknown, chain: string[] = []): RGBA {
    if (value instanceof RGBA) return value
    if (typeof value === "string") {
      if (value === "transparent" || value === "none") return RGBA.fromInts(0, 0, 0, 0)
      if (value.startsWith("#")) return RGBA.fromHex(value)
      if (chain.includes(value)) throw new Error(`Circular color reference: ${[...chain, value].join(" -> ")}`)
      const next = defs[value] ?? theme.theme[value as ThemeColor]
      if (next === undefined) throw new Error(`Color reference "${value}" not found in defs or theme`)
      return resolveColor(next, [...chain, value])
    }
    if (typeof value === "number") return resolveAnsi(value)
    if (!value || typeof value !== "object" || !(mode in value)) throw new Error("Invalid V1 theme color")
    return resolveColor((value as Record<"dark" | "light", unknown>)[mode], chain)
  }

  const resolved = Object.fromEntries(
    Object.entries(theme.theme)
      .filter(([key]) => key !== "selectedListItemText" && key !== "backgroundMenu" && key !== "thinkingOpacity")
      .map(([key, value]) => [key, resolveColor(value)]),
  ) as Partial<Record<Exclude<keyof Theme, "thinkingOpacity" | "_hasSelectedListItemText">, RGBA>>
  const hasSelectedListItemText = theme.theme.selectedListItemText !== undefined
  resolved.selectedListItemText = hasSelectedListItemText
    ? resolveColor(theme.theme.selectedListItemText)
    : resolved.background
  // Element surfaces and the diff context band reuse the panel colour;
  // declared values are ignored.
  resolved.backgroundElement = resolved.backgroundPanel
  resolved.diffContextBg = resolved.backgroundPanel
  resolved.backgroundMenu = theme.theme.backgroundMenu
    ? resolveColor(theme.theme.backgroundMenu)
    : resolved.backgroundElement
  // Diff row highlights wash the declared diff colours over the background, so
  // retinting `diffAdded`/`diffRemoved` retints the highlights with them. The
  // line-number gutter shares the wash; declared values are ignored.
  const addedBg = diffHighlightBg(resolved.diffAdded!)
  const removedBg = diffHighlightBg(resolved.diffRemoved!)
  resolved.diffAddedBg = addedBg
  resolved.diffRemovedBg = removedBg
  resolved.diffAddedLineNumberBg = addedBg
  resolved.diffRemovedLineNumberBg = removedBg

  return {
    ...resolved,
    _hasSelectedListItemText: hasSelectedListItemText,
    thinkingOpacity: theme.theme.thinkingOpacity ?? 0.6,
  } as Theme
}

export function selectedForeground(theme: SyntaxTheme, background?: RGBA): RGBA {
  if (theme._hasSelectedListItemText) return theme.selectedListItemText
  if (theme.background.a !== 0) return theme.background
  const target = background ?? theme.primary
  return 0.299 * target.r + 0.587 * target.g + 0.114 * target.b > 0.5
    ? RGBA.fromInts(0, 0, 0)
    : RGBA.fromInts(255, 255, 255)
}
