import { RemoteControl } from "@opencode-ai/schema/remote-control"
import {
  DEFAULT_THEMES,
  colorToHex,
  isThemeSource,
  parseTheme,
  resolveThemeDocument,
  themeMode,
  type ThemeDocumentSource,
} from "@opencode-ai/theme/tui"
import { Effect, FileSystem, Schema } from "effect"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"

const Config = Schema.Struct({ theme: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })) })

function resolve(name: string, source: ThemeDocumentSource): RemoteControl.Theme {
  const mode = themeMode(source, name)
  const theme = resolveThemeDocument(parseTheme(source, name), mode)
  const actions = (colors: typeof theme.text.action) => ({
    primary: colorToHex(colors.primary.default),
    secondary: colorToHex(colors.secondary.default),
    destructive: colorToHex(colors.destructive.default),
  })
  const feedback = (colors: typeof theme.background.feedback) => ({
    error: colorToHex(colors.error.default),
    warning: colorToHex(colors.warning.default),
    success: colorToHex(colors.success.default),
    info: colorToHex(colors.info.default),
  })
  return {
    name,
    mode,
    colors: {
      text: {
        default: colorToHex(theme.text.default),
        subdued: colorToHex(theme.text.subdued),
        action: actions(theme.text.action),
        status: {
          running: colorToHex(theme.text.status.running),
          question: colorToHex(theme.text.status.question),
          permission: colorToHex(theme.text.status.permission),
          unread: colorToHex(theme.text.status.unread),
        },
        feedback: feedback(theme.text.feedback),
      },
      background: {
        default: colorToHex(theme.background.default),
        offset: colorToHex(theme.background.surface.offset),
        overlay: colorToHex(theme.background.surface.overlay),
        action: actions(theme.background.action),
        feedback: feedback(theme.background.feedback),
      },
      border: { default: colorToHex(theme.border.default) },
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
