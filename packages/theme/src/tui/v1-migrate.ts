import { RGBA } from "@opentui/core"
import { rgbToOklch } from "./color.js"
import { DEFAULT_CATEGORICAL, DEFAULT_THEME } from "./defaults.js"
import type { FileThemeDefinition, Mode, ThemeDocument } from "./index.js"
import { HueStep } from "./schema.js"
import { resolveV1, selectedForeground } from "./v1.js"
import type { Theme, ThemeV1Json } from "./v1.js"

type ThemeColor = Exclude<
  keyof Theme,
  "thinkingOpacity" | "_hasSelectedListItemText" | "agentBuild" | "agentPlan" | "agentCompose"
>
type ChromaticHue = "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple"
type V1HueToken = "secondary" | "accent" | "success" | "warning" | "primary" | "error" | "info"

const chromaticHues: readonly ChromaticHue[] = ["red", "orange", "yellow", "green", "cyan", "blue", "purple"]
// The order V1 handed colours to agents, and the order the categorical scale
// keeps. Entries are emitted as the literal colours rather than the nearest
// hue name: `secondary` and `warning` collapse onto the same hue in most
// themes, and rounding them together loses two distinct agent colours.
const categoricalTokens: readonly V1HueToken[] = [
  "secondary",
  "accent",
  "success",
  "warning",
  "primary",
  "error",
  "info",
]
const minimumChroma = 0.03
const lightThreshold = 0.6

export function migrateV1(theme: ThemeV1Json): ThemeDocument {
  const light = resolveV1(theme, "light")
  const dark = resolveV1(theme, "dark")
  if (light.background.a > 0 && dark.background.a > 0 && light.background.equals(dark.background)) {
    const declared = theme.mode === "light" || theme.mode === "dark" ? theme.mode : undefined
    const detected = detectMode(light) === detectMode(dark) ? detectMode(light) : undefined
    const mode = declared ?? detected
    if (mode === "light") return { version: 2, standalone: true, light: migrateMode(light, "light") }
    if (mode === "dark") return { version: 2, standalone: true, dark: migrateMode(dark, "dark") }
  }
  return {
    version: 2,
    standalone: true,
    light: migrateMode(light, "light"),
    dark: migrateMode(dark, "dark"),
  }
}

function detectMode(theme: Theme): Mode {
  return luminance(theme.text) > luminance(theme.background) ? "dark" : "light"
}

function luminance(color: RGBA) {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b
}

function migrateMode(theme: Theme, mode: Mode): FileThemeDefinition {
  const color = (key: ThemeColor) => hex(theme[key])
  const selected = hex(selectedForeground(theme, theme.primary))
  const destructive = hex(selectedForeground(theme, theme.error))
  const hues = inferHues(theme, mode)
  // A fully transparent semantic colour would hand an agent an invisible label,
  // so it drops out; a theme that names none of the seven falls back.
  const categorical = categoricalTokens.flatMap((token) => {
    const color = theme[token]
    return color && color.toInts()[3] !== 0 ? [hex(color)] : []
  })
  // Declared agent-mode colours; a transparent declaration would paint an
  // invisible label, so it drops out like a transparent categorical entry.
  const agents = Object.fromEntries(
    (
      [
        ["build", theme.agentBuild],
        ["plan", theme.agentPlan],
        ["compose", theme.agentCompose],
      ] as const
    ).flatMap(([id, color]) => (color && color.toInts()[3] !== 0 ? [[id, hex(color)] as const] : [])),
  )
  const text = mode === "light" ? "$hue.neutral.800" : "$hue.neutral.200"
  const textMuted = mode === "light" ? "$hue.neutral.600" : "$hue.neutral.400"
  const primary = mode === "light" ? "$hue.interactive.800" : "$hue.interactive.200"
  const background = mode === "light" ? "$hue.neutral.200" : "$hue.neutral.800"
  const backgroundPanel = mode === "light" ? "$hue.neutral.300" : "$hue.neutral.700"
  const backgroundMenu = mode === "light" ? "$hue.neutral.400" : "$hue.neutral.600"

  return referenceHues(mode, {
    hue: {
      gray: neutralScale(theme, mode),
      ...Object.fromEntries(
        chromaticHues.map((name) => {
          const match = hues.byHue[name]
          return [name, match ? hueScale(match.color) : "$hue.gray"]
        }),
      ),
      accent: hues.byToken.accent ? `$hue.${hues.byToken.accent}` : "$hue.gray",
      interactive: hues.byToken.primary ? `$hue.${hues.byToken.primary}` : "$hue.gray",
      neutral: "$hue.gray",
    },
    categorical: categorical.length ? categorical : DEFAULT_CATEGORICAL,
    ...(Object.keys(agents).length ? { agents } : {}),
    text: {
      default: text,
      subdued: textMuted,
      action: {
        primary: {
          default: "$text.default",
          $disabled: textMuted,
          $focused: selected,
          $selected: primary,
        },
        destructive: { default: destructive, $disabled: textMuted },
      },
      formfield: {
        default: text,
        $hovered: primary,
        $focused: primary,
        $pressed: primary,
        $disabled: textMuted,
        $selected: primary,
      },
      feedback: {
        error: { default: color("error") },
        warning: { default: color("warning") },
        success: { default: color("success") },
        info: { default: color("info") },
      },
    },
    background: {
      default: background,
      surface: {
        offset: backgroundPanel,
        overlay: backgroundMenu,
      },
      action: {
        primary: { default: "transparent", $hovered: backgroundPanel, $focused: primary, $selected: "transparent" },
        destructive: { default: color("error") },
      },
      formfield: {
        default: "$background.default",
      },
      feedback: {
        error: { default: "$background.default" },
        warning: { default: "$background.default" },
        success: { default: "$background.default" },
        info: { default: "$background.default" },
      },
    },
    border: { default: color("border") },
    scrollbar: { default: color("borderActive") },
    diff: {
      text: {
        added: color("diffAdded"),
        removed: color("diffRemoved"),
        context: color("diffContext"),
        hunkHeader: color("diffHunkHeader"),
      },
      background: {
        added: hex(theme.diffAddedBg),
        removed: hex(theme.diffRemovedBg),
        context: hex(theme.diffContextBg),
      },
      highlight: { added: color("diffHighlightAdded"), removed: color("diffHighlightRemoved") },
      lineNumber: {
        text: color("diffLineNumber"),
        background: {
          added: hex(theme.diffAddedLineNumberBg),
          removed: hex(theme.diffRemovedLineNumberBg),
        },
      },
    },
    syntax: {
      comment: color("syntaxComment"),
      keyword: color("syntaxKeyword"),
      function: color("syntaxFunction"),
      variable: color("syntaxVariable"),
      string: color("syntaxString"),
      number: color("syntaxNumber"),
      type: color("syntaxType"),
      operator: color("syntaxOperator"),
      punctuation: color("syntaxPunctuation"),
    },
    markdown: {
      text: color("markdownText"),
      heading: color("markdownHeading"),
      link: color("markdownLink"),
      linkText: color("markdownLinkText"),
      code: color("markdownCode"),
      blockQuote: color("markdownBlockQuote"),
      emphasis: color("markdownEmph"),
      strong: color("markdownStrong"),
      horizontalRule: color("markdownHorizontalRule"),
      listItem: color("markdownListItem"),
      listEnumeration: color("markdownListEnumeration"),
      image: color("markdownImage"),
      imageText: color("markdownImageText"),
      codeBlock: color("markdownCodeBlock"),
    },
    "@context:elevated": {
      background: {
        default: "$background.surface.offset",
        action: { primary: { $hovered: "$background.surface.overlay" } },
      },
    },
    "@context:overlay": { background: { default: "$background.surface.overlay" } },
    // Redsun's wordmark gradient. Upstream V1 themes omit it, and a theme with
    // no gradient of its own falls back to the default document's.
    ...(theme.logoGradientStart && theme.logoGradientEnd
      ? { logo: { gradient: { start: color("logoGradientStart"), end: color("logoGradientEnd") } } }
      : {}),
  })
}

function referenceHues(mode: Mode, theme: FileThemeDefinition): FileThemeDefinition {
  const definitions = theme.hue as Record<string, string | Partial<Record<HueStep, string>>> | undefined
  if (!definitions) return theme
  const scales = new Map<string, Partial<Record<HueStep, string>>>()

  function resolve(name: string, chain: string[] = []): Partial<Record<HueStep, string>> | undefined {
    const cached = scales.get(name)
    if (cached) return cached
    if (chain.includes(name)) return
    const value = definitions?.[name]
    if (!value) return
    if (typeof value !== "string") {
      scales.set(name, value)
      return value
    }
    const target = /^\$hue\.([^.]+)$/.exec(value)?.[1]
    if (!target) return
    const scale = resolve(target, [...chain, name])
    if (scale) scales.set(name, scale)
    return scale
  }

  // A snapped scale repeats one colour across a run of steps, so the anchor is
  // indexed first: a token keeps a reference to the step its colour was
  // actually declared for rather than to whichever duplicate sorts lowest.
  const anchor: HueStep = mode === "light" ? 800 : 200
  const order = [anchor, ...HueStep.literals.filter((step) => step !== anchor)]
  const references = new Map<string, string>()
  const index = (name: string, overwrite: boolean) => {
    const scale = resolve(name)
    if (!scale) return
    const seen = new Set<string>()
    order.forEach((step) => {
      const color = scale[step]
      if (!color) return
      const key = color.toLowerCase()
      if (seen.has(key) || (!overwrite && references.has(key))) return
      seen.add(key)
      references.set(key, `$hue.${name}.${step}`)
    })
  }
  chromaticHues.forEach((name) => index(name, false))
  index("gray", false)
  index("accent", true)
  index("interactive", true)
  index("neutral", true)

  function replace(value: unknown): unknown {
    if (typeof value === "string") return references.get(value.toLowerCase()) ?? value
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
  }

  return Object.fromEntries(
    Object.entries(theme).map(([key, value]) => [key, key === "hue" || key === "categorical" ? value : replace(value)]),
  ) as FileThemeDefinition
}

function inferHues(theme: Theme, mode: "light" | "dark") {
  const colors: readonly [V1HueToken, RGBA][] = [
    ["accent", theme.accent],
    ["success", theme.success],
    ["warning", theme.warning],
    ["primary", theme.primary],
    ["error", theme.error],
    ["info", theme.info],
    ["secondary", theme.secondary],
  ]
  const inferred = colors.reduce<{
    byHue: Partial<Record<ChromaticHue, { color: RGBA; distance: number }>>
    byToken: Partial<Record<V1HueToken, ChromaticHue>>
  }>(
    (result, [token, color]) => {
      const nearest = inferHue(color, mode)
      if (!nearest) return result
      const current = result.byHue[nearest.name]
      return {
        byHue:
          current && current.distance <= nearest.distance
            ? result.byHue
            : { ...result.byHue, [nearest.name]: { color, distance: nearest.distance } },
        byToken: { ...result.byToken, [token]: nearest.name },
      }
    },
    { byHue: {}, byToken: {} },
  )
  return (
    [
      ["accent", theme.accent],
      ["primary", theme.primary],
    ] as const
  ).reduce((result, [token, color]) => {
    const nearest = inferHue(color, mode)
    if (!nearest) return result
    return {
      byHue: { ...result.byHue, [nearest.name]: { color, distance: nearest.distance } },
      byToken: { ...result.byToken, [token]: nearest.name },
    }
  }, inferred)
}

function inferHue(color: RGBA, mode: Mode) {
  const value = toOklch(color)
  if (ambiguous(color, value.c)) return
  const anchor = inferenceAnchor(value.l)
  return chromaticHues
    .map((name) => ({
      name,
      distance: hueDistance(value.h, toOklch(RGBA.fromHex(DEFAULT_THEME[mode].hue[name][anchor])).h),
    }))
    .sort((first, second) => first.distance - second.distance)[0]
}

function inferenceAnchor(lightness: number): HueStep {
  return lightness >= lightThreshold ? 300 : 700
}

function hueDistance(first: number, second: number) {
  const difference = Math.abs(first - second)
  return Math.min(difference, 360 - difference)
}

function ambiguous(color: RGBA, chroma = toOklch(color).c) {
  return color.toInts()[3] === 0 || chroma < minimumChroma
}

// A migrated ramp only ever answers with a colour the V1 file named. Each step
// takes the nearest anchor at or below it, and a step below the lowest anchor
// takes that lowest anchor. A chromatic hue declares exactly one anchor, so its
// scale is pinned to that colour.
function hueScale(color: RGBA) {
  return Object.fromEntries(HueStep.literals.map((step) => [step, hex(color)])) as Record<HueStep, string>
}

function neutralScale(theme: Theme, mode: "light" | "dark") {
  const anchors = neutralAnchors(theme, mode)
  return Object.fromEntries(
    HueStep.literals.map((step) => {
      const anchor = anchors.findLast((entry) => entry.step <= step) ?? anchors[0]!
      return [step, hex(anchor.color)]
    }),
  ) as Record<HueStep, string>
}

function neutralAnchors(theme: Theme, mode: "light" | "dark") {
  const light: { step: HueStep; color: RGBA }[] = [
    { step: 200, color: theme.background },
    { step: 300, color: theme.backgroundPanel },
    { step: 400, color: theme.backgroundElement || theme.backgroundMenu },
    { step: 600, color: theme.textMuted },
    { step: 800, color: theme.text },
  ]
  if (mode === "light") return light
  return light.toReversed().map((source) => ({ ...source, step: (1000 - source.step) as HueStep }))
}

function toOklch(color: RGBA) {
  const [red, green, blue] = color.toInts()
  return rgbToOklch(red / 255, green / 255, blue / 255)
}

function hex(color: RGBA) {
  return hexInts(...color.toInts())
}

function hexInts(r: number, g: number, b: number, a: number) {
  return `#${byte(r)}${byte(g)}${byte(b)}${a === 255 ? "" : byte(a)}`
}

function byte(value: number) {
  return value.toString(16).padStart(2, "0")
}

function ansi(code: number) {
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
