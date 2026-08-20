import { RGBA } from "@opentui/core"
import { ansiToRgba } from "./color"
import type { ColorValue, Theme, ThemeColor, ThemeV1Json } from "./v1"

export function resolveThemeColors(
  theme: ThemeV1Json,
  mode: "dark" | "light",
  resolveAnsi: (code: number) => RGBA = ansiToRgba,
) {
  const defs = theme.defs ?? {}
  function resolveColor(color: ColorValue, chain: string[] = []): RGBA {
    if (color instanceof RGBA) return color
    if (typeof color === "string") {
      if (color === "transparent" || color === "none") return RGBA.fromInts(0, 0, 0, 0)

      if (color.startsWith("#")) return RGBA.fromHex(color)

      if (chain.includes(color)) {
        throw new Error(`Circular color reference: ${[...chain, color].join(" -> ")}`)
      }

      const next = defs[color] ?? theme.theme[color as ThemeColor]
      if (next === undefined) {
        throw new Error(`Color reference "${color}" not found in defs or theme`)
      }
      return resolveColor(next, [...chain, color])
    }
    if (typeof color === "number") return resolveAnsi(color)
    return resolveColor(color[mode], chain)
  }

  const resolved = Object.fromEntries(
    Object.entries(theme.theme)
      .filter(([key]) => key !== "selectedListItemText" && key !== "backgroundMenu" && key !== "thinkingOpacity")
      .map(([key, value]) => [key, resolveColor(value as ColorValue)]),
  ) as Partial<Record<ThemeColor, RGBA>>

  const hasSelectedListItemText = theme.theme.selectedListItemText !== undefined
  // Diff row highlights wash the declared diff colours over the background;
  // the line-number gutter shares the wash. Declared values are ignored so the
  // highlights always follow `diffAdded`/`diffRemoved`.
  const diffHighlightBg = (color: RGBA) => RGBA.fromValues(color.r, color.g, color.b, color.a * 0.2)
  const diffAddedBg = diffHighlightBg(resolved.diffAdded!)
  const diffRemovedBg = diffHighlightBg(resolved.diffRemoved!)
  // Element surfaces and the diff context band reuse the panel colour.
  const backgroundElement = resolved.backgroundPanel!
  return {
    theme: {
      ...(resolved as Record<ThemeColor, RGBA>),
      selectedListItemText: hasSelectedListItemText
        ? resolveColor(theme.theme.selectedListItemText!)
        : resolved.background!,
      backgroundElement,
      diffContextBg: backgroundElement,
      backgroundMenu:
        theme.theme.backgroundMenu === undefined ? backgroundElement : resolveColor(theme.theme.backgroundMenu),
      diffAddedBg,
      diffRemovedBg,
      diffAddedLineNumberBg: diffAddedBg,
      diffRemovedLineNumberBg: diffRemovedBg,
    } satisfies Omit<Theme, "_hasSelectedListItemText" | "thinkingOpacity">,
    hasSelectedListItemText,
    thinkingOpacity: theme.theme.thinkingOpacity ?? 0.6,
  }
}
