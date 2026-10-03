import { RGBA } from "@opentui/core"
import { rgbToOklch } from "./color.js"
import { DEFAULT_CATEGORICAL } from "./categorical.js"
import type { BaseThemeDefinition, HueDefinition, Mode, ThemeDefinition, ThemeDocument } from "./index.js"
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
// Canonical swatches copied from the original default-theme classifier keep V1 migration self-contained.
const hueReferences = {
  light: {
    red: "#fca5a5",
    orange: "#fdba74",
    yellow: "#fde047",
    green: "#86efac",
    cyan: "#67e8f9",
    blue: "#93c5fd",
    purple: "#d8b4fe",
  },
  dark: {
    red: "#b91c1c",
    orange: "#c2410c",
    yellow: "#a16207",
    green: "#15803d",
    cyan: "#0e7490",
    blue: "#1d4ed8",
    purple: "#7e22ce",
  },
} satisfies Record<"light" | "dark", Record<ChromaticHue, string>>

const hueAngles = Object.fromEntries(
  Object.entries(hueReferences).map(([level, colors]) => [
    level,
    Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, toOklch(RGBA.fromHex(color)).h])),
  ]),
) as Record<"light" | "dark", Record<ChromaticHue, number>>

export function migrateV1(theme: ThemeV1Json): ThemeDocument {
  const light = resolveV1(theme, "light")
  const dark = resolveV1(theme, "dark")
  if (light.background.a > 0 && dark.background.a > 0 && light.background.equals(dark.background)) {
    const declared = theme.mode === "light" || theme.mode === "dark" ? theme.mode : undefined
    const detected = detectMode(light) === detectMode(dark) ? detectMode(light) : undefined
    const mode = declared ?? detected
    if (mode) {
      const definition = migrateMode(mode === "light" ? light : dark, mode)
      if (mode === "light") return { base: base(definition), light: { hue: definition.hue } }
      return { base: base(definition), dark: { hue: definition.hue } }
    }
  }
  const lightDefinition = migrateMode(light, "light")
  const darkDefinition = migrateMode(dark, "dark")
  return {
    base: base(lightDefinition),
    light: { hue: lightDefinition.hue },
    dark: darkDefinition,
  }
}

function base(definition: ThemeDefinition): BaseThemeDefinition {
  const { hue: _, ...base } = definition
  return base
}

function detectMode(theme: Theme): Mode {
  return luminance(theme.text) > luminance(theme.background) ? "dark" : "light"
}

function luminance(color: RGBA) {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b
}

function migrateMode(theme: Theme, mode: Mode): ThemeDefinition {
  const color = (key: ThemeColor) => hex(theme[key])
  const selected = hex(selectedForeground(theme, theme.primary))
  const destructive = hex(selectedForeground(theme, theme.error))
  const hues = inferHues(theme)
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
  const text = "$hue.neutral.200"
  const textMuted = "$hue.neutral.400"
  const primary = "$hue.interactive.200"
  const background = "$hue.neutral.800"
  const backgroundPanel = "$hue.neutral.700"
  const backgroundMenu = "$hue.neutral.600"
  // A migrated ramp never invents a colour, and step 500 of the neutral ramp is
  // the muted text colour, so the highest raised surface reuses the menu one.
  const backgroundRaisedMax = backgroundMenu

  return referenceHues({
    hue: {
      gray: neutralScale(theme),
      ...Object.fromEntries(
        chromaticHues.map((name) => {
          const match = hues.byHue[name]
          return [name, match ? hueScale(match.color) : "$hue.gray"]
        }),
      ),
      accent: hues.byToken.accent ? `$hue.${hues.byToken.accent}` : "$hue.gray",
      interactive: hues.byToken.primary ? `$hue.${hues.byToken.primary}` : "$hue.gray",
      neutral: "$hue.gray",
    } as HueDefinition,
    categorical: categorical.length ? categorical : DEFAULT_CATEGORICAL,
    ...(Object.keys(agents).length ? { agents } : {}),
    text: {
      base: text,
      muted: textMuted,
      action: {
        primary: {
          base: "$text.base",
          $disabled: textMuted,
          $focused: selected,
          $selected: primary,
        },
        secondary: { base: "$text.muted", $hovered: "$text.base" },
        destructive: { base: destructive, $disabled: textMuted },
      },
      formfield: {
        base: text,
        $hovered: primary,
        $focused: primary,
        $pressed: primary,
        $disabled: textMuted,
        $selected: primary,
      },
      feedback: {
        error: { base: color("error") },
        warning: { base: color("warning") },
        success: { base: color("success") },
        info: { base: color("info") },
      },
    },
    background: {
      base: background,
      raised: {
        base: backgroundPanel,
        high: backgroundMenu,
        max: backgroundRaisedMax,
      },
      action: {
        primary: { base: "transparent", $hovered: backgroundPanel, $focused: primary, $selected: "transparent" },
        secondary: { base: "transparent" },
        destructive: { base: color("error") },
      },
      formfield: {
        base: "$background.base",
      },
      feedback: {
        error: { base: "$background.base" },
        warning: { base: "$background.base" },
        success: { base: "$background.base" },
        info: { base: "$background.base" },
      },
    },
    border: { base: color("border") },
    scrollbar: { base: color("borderActive") },
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
    "@dialog": {
      background: {
        base: "$background.raised.base",
        action: { primary: { $hovered: "$background.raised.high" } },
      },
    },
    // Redsun's wordmark gradient. Upstream V1 themes omit it, and a theme with
    // no gradient of its own falls back to the resolver's default.
    ...(theme.logoGradientStart && theme.logoGradientEnd
      ? { logo: { gradient: { start: color("logoGradientStart"), end: color("logoGradientEnd") } } }
      : {}),
  })
}

function referenceHues(theme: ThemeDefinition): ThemeDefinition {
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
  const anchor: HueStep = 200
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
  ) as ThemeDefinition
}

function inferHues(theme: Theme) {
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
      const nearest = inferHue(color)
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
    const nearest = inferHue(color)
    if (!nearest) return result
    return {
      byHue: { ...result.byHue, [nearest.name]: { color, distance: nearest.distance } },
      byToken: { ...result.byToken, [token]: nearest.name },
    }
  }, inferred)
}

function inferHue(color: RGBA) {
  const value = toOklch(color)
  if (ambiguous(color, value.c)) return
  const reference = value.l >= lightThreshold ? hueAngles.light : hueAngles.dark
  return chromaticHues
    .map((name) => ({
      name,
      distance: hueDistance(value.h, reference[name]),
    }))
    .sort((first, second) => first.distance - second.distance)[0]
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

function neutralScale(theme: Theme) {
  const anchors = neutralAnchors(theme)
  return Object.fromEntries(
    HueStep.literals.map((step) => {
      const anchor = anchors.findLast((entry) => entry.step <= step) ?? anchors[0]!
      return [step, hex(anchor.color)]
    }),
  ) as Record<HueStep, string>
}

function neutralAnchors(theme: Theme) {
  const light: { step: HueStep; color: RGBA }[] = [
    { step: 200, color: theme.background },
    { step: 300, color: theme.backgroundPanel },
    { step: 400, color: theme.backgroundElement || theme.backgroundMenu },
    { step: 600, color: theme.textMuted },
    { step: 800, color: theme.text },
  ]
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
