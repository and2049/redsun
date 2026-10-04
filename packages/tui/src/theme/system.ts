import { RGBA, rgbToHex, type TerminalColors } from "@opentui/core"
import { ansiToRgba, type HexColor, type ThemeV1Json } from "@opencode/theme/tui/v1"
import { tint } from "./color"

export function terminalMode(colors: TerminalColors): "dark" | "light" | undefined {
  const bg = colors.defaultBackground
  if (!bg) return
  const { r, g, b } = RGBA.fromHex(bg)
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? "light" : "dark"
}

/** The theme built from the terminal's own colours; listed only once the terminal has reported them. */
export const SYSTEM_THEME = "system"

// Steps from the terminal background toward its foreground. The palette has no
// surface or border colours of its own, so they are mixed from the two defaults.
const PANEL = 0.07
const BORDER = 0.28
const MUTED = 0.6

/**
 * A V1 theme from the terminal's reported colours: its default foreground and background
 * and the first eight ANSI slots. Undefined when the terminal did not report its defaults.
 */
export function systemTheme(colors: TerminalColors): ThemeV1Json | undefined {
  if (!colors.defaultBackground || !colors.defaultForeground) return
  const background = RGBA.fromHex(colors.defaultBackground)
  const foreground = RGBA.fromHex(colors.defaultForeground)
  const hex = (color: RGBA) => rgbToHex(color) as HexColor
  const ansi = (slot: number) => hex(colors.palette[slot] ? RGBA.fromHex(colors.palette[slot]) : ansiToRgba(slot))
  const mix = (alpha: number) => hex(tint(background, foreground, alpha))
  const [red, green, yellow, blue, magenta, cyan] = [ansi(1), ansi(2), ansi(3), ansi(4), ansi(5), ansi(6)]
  const text = hex(foreground)
  const muted = mix(MUTED)
  const border = mix(BORDER)
  return {
    mode: terminalMode(colors),
    theme: {
      logoGradientStart: yellow,
      logoGradientEnd: red,
      primary: cyan,
      secondary: magenta,
      accent: cyan,
      error: red,
      warning: yellow,
      success: green,
      info: cyan,
      // Not the feedback colours: an agent sharing one would read as a state.
      agentBuild: blue,
      agentPlan: magenta,
      agentCompose: cyan,
      text,
      textMuted: muted,
      background: hex(background),
      backgroundPanel: mix(PANEL),
      border,
      borderActive: cyan,
      borderSubtle: mix(PANEL),
      diffAdded: green,
      diffRemoved: red,
      diffContext: muted,
      diffHunkHeader: muted,
      diffHighlightAdded: green,
      diffHighlightRemoved: red,
      diffLineNumber: border,
      markdownText: text,
      markdownHeading: magenta,
      markdownLink: blue,
      markdownLinkText: cyan,
      markdownCode: green,
      markdownBlockQuote: muted,
      markdownEmph: yellow,
      markdownStrong: text,
      markdownHorizontalRule: border,
      markdownListItem: text,
      markdownListEnumeration: cyan,
      markdownImage: blue,
      markdownImageText: cyan,
      markdownCodeBlock: text,
      syntaxComment: muted,
      syntaxKeyword: magenta,
      syntaxFunction: blue,
      syntaxVariable: text,
      syntaxString: green,
      syntaxNumber: yellow,
      syntaxType: cyan,
      syntaxOperator: text,
      syntaxPunctuation: text,
    },
  }
}
