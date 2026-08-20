import type { RGBA } from "@opentui/core"

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
  readonly thinkingOpacity: number
  _hasSelectedListItemText: boolean
}

export type ThemeColor = Exclude<keyof Theme, "thinkingOpacity" | "_hasSelectedListItemText">
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
    // Redsun tokens; upstream V1 themes have no wordmark gradient.
    logoGradientStart?: ColorValue
    logoGradientEnd?: ColorValue
    selectedListItemText?: ColorValue
    backgroundMenu?: ColorValue
    thinkingOpacity?: number
  }
}
