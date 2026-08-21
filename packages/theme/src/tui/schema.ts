import { Schema } from "effect"

export const HueStep = Schema.Literals([100, 200, 300, 400, 500, 600, 700, 800, 900])
export type HueStep = Schema.Schema.Type<typeof HueStep>

export const BaseHue = Schema.Literals(["gray", "red", "orange", "yellow", "green", "cyan", "blue", "purple"])
export type BaseHue = Schema.Schema.Type<typeof BaseHue>

export const HueAlias = Schema.Literals(["accent", "interactive", "neutral"])
export type HueAlias = Schema.Schema.Type<typeof HueAlias>

export const ActionVariant = Schema.Literals(["primary", "secondary", "destructive"])
export type ActionVariant = Schema.Schema.Type<typeof ActionVariant>

export const ActionState = Schema.Literals(["disabled", "pressed", "focused", "selected", "hovered"])
export type ActionState = Schema.Schema.Type<typeof ActionState>
export type ActionStateKey = `$${ActionState}`

export const FormfieldState = ActionState
export type FormfieldState = ActionState
export type FormfieldStateKey = `$${FormfieldState}`

export const FeedbackKind = Schema.Literals(["error", "warning", "success", "info"])
export type FeedbackKind = Schema.Schema.Type<typeof FeedbackKind>

const Mode = Schema.Literals(["light", "dark"])
export type Mode = Schema.Schema.Type<typeof Mode>

const HexColor = Schema.String.check(Schema.isPattern(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i))

const ColorValue = Schema.Union([
  HexColor,
  Schema.Literal("transparent"),
  Schema.TemplateLiteral(["$", Schema.NonEmptyString]),
])

export const HueName = Schema.Union([BaseHue, HueAlias])
export type HueName = Schema.Schema.Type<typeof HueName>
const HueColorValue = Schema.Union([HexColor, Schema.TemplateLiteral(["$hue.", HueName, ".", HueStep])])
// A bare hue name contributes its whole scale, so a consumer can pick the step
// that suits its mode. A step reference or a literal colour pins one shade --
// V1 palettes name seven exact colours, several of which round to the same hue.
export const CategoricalDefinition = Schema.Array(Schema.Union([HueName, HueColorValue])).check(Schema.isMinLength(1))
export type CategoricalDefinition = Schema.Schema.Type<typeof CategoricalDefinition>

// Per-agent colours keyed by agent id. An agent named here always paints with
// its declared colour; agents a theme does not name keep their positional
// assignment from the categorical scale.
export const AgentsDefinition = Schema.Record(Schema.String, ColorValue)
export type AgentsDefinition = Schema.Schema.Type<typeof AgentsDefinition>

const ContextKey = Schema.Literals(["@context:elevated", "@context:overlay"])
export type ContextKey = Schema.Schema.Type<typeof ContextKey>

const HueScaleDefinition = Schema.Record(HueStep, HexColor)
const HueValueDefinition = Schema.Union([Schema.TemplateLiteral(["$hue.", HueName]), HueScaleDefinition])

const HueDefinition = Schema.Struct({
  gray: HueValueDefinition,
  red: HueValueDefinition,
  orange: HueValueDefinition,
  yellow: HueValueDefinition,
  green: HueValueDefinition,
  cyan: HueValueDefinition,
  blue: HueValueDefinition,
  purple: HueValueDefinition,
  accent: HueValueDefinition,
  interactive: HueValueDefinition,
  neutral: HueValueDefinition,
})
export type HueDefinition = Schema.Schema.Type<typeof HueDefinition>

const HueOverrideDefinition = Schema.Struct({
  gray: Schema.optional(HueValueDefinition),
  red: Schema.optional(HueValueDefinition),
  orange: Schema.optional(HueValueDefinition),
  yellow: Schema.optional(HueValueDefinition),
  green: Schema.optional(HueValueDefinition),
  cyan: Schema.optional(HueValueDefinition),
  blue: Schema.optional(HueValueDefinition),
  purple: Schema.optional(HueValueDefinition),
  accent: Schema.optional(HueValueDefinition),
  interactive: Schema.optional(HueValueDefinition),
  neutral: Schema.optional(HueValueDefinition),
})
export type HueOverrideDefinition = Schema.Schema.Type<typeof HueOverrideDefinition>

const StatefulColorDefinition = Schema.Struct({
  default: Schema.optional(ColorValue),
  $hovered: Schema.optional(ColorValue),
  $focused: Schema.optional(ColorValue),
  $pressed: Schema.optional(ColorValue),
  $selected: Schema.optional(ColorValue),
  $disabled: Schema.optional(ColorValue),
})
export type StatefulColorDefinition = Schema.Schema.Type<typeof StatefulColorDefinition>

export type FormfieldColorDefinition = StatefulColorDefinition

const ActionColorDefinition = Schema.Struct({
  primary: Schema.optional(StatefulColorDefinition),
  secondary: Schema.optional(StatefulColorDefinition),
  destructive: Schema.optional(StatefulColorDefinition),
})

const TextFeedbackDefinition = Schema.Struct({
  default: Schema.optional(ColorValue),
  subdued: Schema.optional(ColorValue),
})

const BackgroundFeedbackDefinition = Schema.Struct({
  default: Schema.optional(ColorValue),
})

const TextDefinition = Schema.Struct({
  default: Schema.optional(ColorValue),
  subdued: Schema.optional(ColorValue),
  action: Schema.optional(ActionColorDefinition),
  formfield: Schema.optional(StatefulColorDefinition),
  feedback: Schema.optional(
    Schema.Struct({
      error: Schema.optional(TextFeedbackDefinition),
      warning: Schema.optional(TextFeedbackDefinition),
      success: Schema.optional(TextFeedbackDefinition),
      info: Schema.optional(TextFeedbackDefinition),
    }),
  ),
})
export type TextDefinition = Schema.Schema.Type<typeof TextDefinition>

const BackgroundDefinition = Schema.Struct({
  default: Schema.optional(ColorValue),
  surface: Schema.optional(
    Schema.Struct({
      offset: Schema.optional(ColorValue),
      overlay: Schema.optional(ColorValue),
    }),
  ),
  action: Schema.optional(ActionColorDefinition),
  formfield: Schema.optional(StatefulColorDefinition),
  feedback: Schema.optional(
    Schema.Struct({
      error: Schema.optional(BackgroundFeedbackDefinition),
      warning: Schema.optional(BackgroundFeedbackDefinition),
      success: Schema.optional(BackgroundFeedbackDefinition),
      info: Schema.optional(BackgroundFeedbackDefinition),
    }),
  ),
})
export type BackgroundDefinition = Schema.Schema.Type<typeof BackgroundDefinition>

export const SyntaxToken = Schema.Literals([
  "comment",
  "keyword",
  "function",
  "variable",
  "string",
  "number",
  "type",
  "operator",
  "punctuation",
])
export type SyntaxToken = Schema.Schema.Type<typeof SyntaxToken>
export const SyntaxDefinition = Schema.Record(SyntaxToken, Schema.optionalKey(HueColorValue))
export type SyntaxDefinition = Schema.Schema.Type<typeof SyntaxDefinition>

export const MarkdownToken = Schema.Literals([
  "text",
  "heading",
  "link",
  "linkText",
  "code",
  "blockQuote",
  "emphasis",
  "strong",
  "horizontalRule",
  "listItem",
  "listEnumeration",
  "image",
  "imageText",
  "codeBlock",
])
export type MarkdownToken = Schema.Schema.Type<typeof MarkdownToken>
export const MarkdownDefinition = Schema.Record(MarkdownToken, Schema.optionalKey(HueColorValue))
export type MarkdownDefinition = Schema.Schema.Type<typeof MarkdownDefinition>

const DiffDefinition = Schema.Struct({
  text: Schema.optional(
    Schema.Struct({
      added: Schema.optional(ColorValue),
      removed: Schema.optional(ColorValue),
      context: Schema.optional(ColorValue),
      hunkHeader: Schema.optional(ColorValue),
    }),
  ),
  background: Schema.optional(
    Schema.Struct({
      added: Schema.optional(ColorValue),
      removed: Schema.optional(ColorValue),
      context: Schema.optional(ColorValue),
    }),
  ),
  highlight: Schema.optional(
    Schema.Struct({ added: Schema.optional(ColorValue), removed: Schema.optional(ColorValue) }),
  ),
  lineNumber: Schema.optional(
    Schema.Struct({
      text: Schema.optional(ColorValue),
      background: Schema.optional(
        Schema.Struct({ added: Schema.optional(ColorValue), removed: Schema.optional(ColorValue) }),
      ),
    }),
  ),
})
export type DiffDefinition = Schema.Schema.Type<typeof DiffDefinition>

const LogoDefinition = Schema.Struct({
  gradient: Schema.optional(Schema.Struct({ start: Schema.optional(ColorValue), end: Schema.optional(ColorValue) })),
})

const ThemeTokensDefinition = Schema.Struct({
  agents: Schema.optional(AgentsDefinition),
  text: Schema.optional(TextDefinition),
  background: Schema.optional(BackgroundDefinition),
  border: Schema.optional(Schema.Struct({ default: Schema.optional(ColorValue) })),
  scrollbar: Schema.optional(Schema.Struct({ default: Schema.optional(ColorValue) })),
  logo: Schema.optional(LogoDefinition),
  diff: Schema.optional(DiffDefinition),
  syntax: Schema.optional(SyntaxDefinition),
  markdown: Schema.optional(MarkdownDefinition),
})
export type ThemeTokensDefinition = Schema.Schema.Type<typeof ThemeTokensDefinition>

const ThemeDefinitionFields = Schema.Struct({
  hue: HueDefinition,
  categorical: Schema.optional(CategoricalDefinition),
  ...ThemeTokensDefinition.fields,
  "@context:elevated": Schema.optional(ThemeTokensDefinition),
  "@context:overlay": Schema.optional(ThemeTokensDefinition),
})
export const ThemeDefinition = ThemeDefinitionFields
export type ThemeDefinition = Schema.Schema.Type<typeof ThemeDefinition>

const FileThemeDefinition = Schema.Struct({
  hue: Schema.optional(HueOverrideDefinition),
  categorical: Schema.optional(CategoricalDefinition),
  ...ThemeTokensDefinition.fields,
  "@context:elevated": Schema.optional(ThemeTokensDefinition),
  "@context:overlay": Schema.optional(ThemeTokensDefinition),
})
export type FileThemeDefinition = Schema.Schema.Type<typeof FileThemeDefinition>

const MergeModeDefinition = Schema.Struct({
  mergeMode: Schema.Literal(true),
  hue: Schema.optional(HueOverrideDefinition),
  categorical: Schema.optional(CategoricalDefinition),
  ...ThemeTokensDefinition.fields,
  "@context:elevated": Schema.optional(ThemeTokensDefinition),
  "@context:overlay": Schema.optional(ThemeTokensDefinition),
})
export type MergeModeDefinition = Schema.Schema.Type<typeof MergeModeDefinition>
export const ModeDefinition = Schema.Union([MergeModeDefinition, FileThemeDefinition])
export type ModeDefinition = Schema.Schema.Type<typeof ModeDefinition>

const FileMetadata = {
  $schema: Schema.optional(Schema.String),
  version: Schema.Literal(2),
  standalone: Schema.optional(Schema.Boolean),
}
export const ThemeDocument = Schema.Union([
  Schema.Struct({ ...FileMetadata, light: ModeDefinition, dark: Schema.optional(ModeDefinition) }),
  Schema.Struct({ ...FileMetadata, light: Schema.optional(ModeDefinition), dark: ModeDefinition }),
])
export type ThemeDocument = Schema.Schema.Type<typeof ThemeDocument>
