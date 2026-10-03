import { RemoteControl } from "@opencode/schema/remote-control"
import {
  DEFAULT_THEMES,
  colorToHex,
  isThemeSource,
  parseTheme,
  resolveThemeDocument,
  themeMode,
  type ThemeDocumentSource,
} from "@opencode/theme/tui"
import { Effect, FileSystem, Schema } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"

const Config = Schema.Struct({ theme: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })) })

function resolve(name: string, source: ThemeDocumentSource): RemoteControl.Theme {
  const mode = themeMode(source, name)
  const theme = resolveThemeDocument(parseTheme(source, name), mode)
  const actions = (colors: typeof theme.text.action) => ({
    primary: colorToHex(colors.primary.base),
    secondary: colorToHex(colors.secondary.base),
    destructive: colorToHex(colors.destructive.base),
  })
  const feedback = (colors: typeof theme.background.feedback) => ({
    error: colorToHex(colors.error.base),
    warning: colorToHex(colors.warning.base),
    success: colorToHex(colors.success.base),
    info: colorToHex(colors.info.base),
  })
  // The wire keeps the pre-2.0.7 token names. Themes no longer carry status
  // colours, so these are the hue steps the old defaults resolved them to.
  const attention = colorToHex(theme.hue.accent[200])
  return {
    name,
    mode,
    colors: {
      text: {
        default: colorToHex(theme.text.base),
        subdued: colorToHex(theme.text.muted),
        action: actions(theme.text.action),
        status: {
          running: colorToHex(theme.hue.interactive[200]),
          question: attention,
          permission: attention,
          unread: attention,
        },
        feedback: feedback(theme.text.feedback),
      },
      background: {
        default: colorToHex(theme.background.base),
        offset: colorToHex(theme.background.raised.base),
        overlay: colorToHex(theme.background.raised.high),
        action: actions(theme.background.action),
        feedback: feedback(theme.background.feedback),
      },
      border: { default: colorToHex(theme.border.base) },
      diff: { added: colorToHex(theme.diff.text.added), removed: colorToHex(theme.diff.text.removed) },
      markdown: {
        text: colorToHex(theme.markdown.text),
        heading: colorToHex(theme.markdown.heading),
        link: colorToHex(theme.markdown.link),
        linkText: colorToHex(theme.markdown.linkText),
        code: colorToHex(theme.markdown.code),
        blockQuote: colorToHex(theme.markdown.blockQuote),
        emphasis: colorToHex(theme.markdown.emphasis),
        strong: colorToHex(theme.markdown.strong),
        horizontalRule: colorToHex(theme.markdown.horizontalRule),
        listItem: colorToHex(theme.markdown.listItem),
        listEnumeration: colorToHex(theme.markdown.listEnumeration),
        image: colorToHex(theme.markdown.image),
        imageText: colorToHex(theme.markdown.imageText),
        codeBlock: colorToHex(theme.markdown.codeBlock),
      },
    },
  }
}

export const remoteTheme = Effect.fnUntraced(function* (config: string, fs: FileSystem.FileSystem) {
  const name = yield* fs.readFileString(path.join(config, "cli.json")).pipe(
    Effect.flatMap((text) =>
      Effect.try(() => {
        const errors: ParseError[] = []
        const input: unknown = parse(text, errors, { allowTrailingComma: true })
        if (errors.length) return "dusk"
        return Schema.decodeUnknownSync(Config)(input).theme?.name ?? "dusk"
      }),
    ),
    Effect.orElseSucceed(() => "dusk"),
  )
  const directory = path.join(config, "themes")
  const files = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))
  const themes = new Map(Object.entries(DEFAULT_THEMES))
  for (const file of files.filter((file) => path.extname(file) === ".json").sort()) {
    const source = yield* fs.readFileString(path.join(directory, file)).pipe(
      Effect.flatMap((text) => Effect.try((): unknown => JSON.parse(text))),
      Effect.orElseSucceed(() => undefined),
    )
    const key = path.basename(file, ".json")
    if (isThemeSource(source)) themes.set(key, source)
    else if (key === name) themes.delete(key)
  }
  const selected = themes.has(name) ? name : "dusk"
  return yield* Effect.try(() => resolve(selected, themes.get(selected)!)).pipe(
    Effect.catch(() => Effect.try(() => resolve("dusk", themes.get("dusk")!))),
    Effect.orElseSucceed(() => resolve("dusk", DEFAULT_THEMES.dusk!)),
  )
})
