# TUI translation catalog

`catalog.ts` contains 77 exact upstream translation reuses. The source is
`upstream/beta` at commit
`20aff6d9f643afe9abf8a048e68f019d049f5329`:

- `packages/app/src/runtime/i18n/en.ts`
- `packages/app/src/runtime/i18n/zh.ts` (Simplified Chinese; the actual filename)
- `packages/app/src/runtime/i18n/es.ts`
- `packages/app/src/runtime/i18n/ko.ts`
- `packages/app/src/runtime/i18n/fr.ts`

Catalog keys are English UI source text. Tuple order is `zh-CN`, `es`, `ko`,
`fr`. Every reused interpolation token is preserved in all four values. The
catalog contains only static author-owned UI strings; dynamic model, provider,
path, status, tool, and user content is not translated automatically.

## Runtime and authoring

`ConfigProvider` supplies a reactive `LanguageContext` from `cli.json`'s `language`
preference. `useLanguage().t()` reads it at render time. Components used without a
provider default to English. The picker at `/language` saves through the ordinary
CLI config service; it does not change backend config or assistant instructions.

Translate labels in JSX, memoized options, or command-layer accessors so changes
apply to mounted views. Keep canonical IDs and native language names unchanged.
Use complete singular/plural messages instead of appending an English `s`.
`catalog.ts` takes precedence for shared upstream wording; TUI-specific meanings
need distinct English source text instead of an ambiguous duplicate key.
`aliases.ts` adds seven reviewed semantic aliases to upstream messages, including
Thinking → Reasoning and Undo previous message → Undo the last message. See
`GLOSSARY.md` for domain terminology and distinctions that must survive reuse.

Tests from `packages/tui`:

```sh
bun test test/i18n.test.ts test/language-lifecycle.test.tsx test/component/dialog-language.test.tsx test/component/dialog-localization.test.tsx
```

`bun test test/config.test.ts` from `packages/cli` covers disk persistence. Literal
translation calls are checked for catalog coverage, and every locale must preserve
the source message's interpolation parameters.

## Machine-checkable source manifest

Each upstream key below maps to the English value used as the catalog key. The
manifest is compact because it groups unambiguous upstream namespaces:

```text
command.category.{server,session,theme,context,terminal,model,mcp,agent,permissions,settings,suggested}
command.settings.open
command.session.{previous,next,new,compact,redo,undo.description,export}
command.agent.{cycle,cycle.reverse}
command.palette
command.theme.{cycle,set}
command.file.open
command.input.focus
command.steps.toggle
command.message.{previous,next}
command.model.choose
command.prompt.mode.shell
dialog.model.select.title
common.{search.placeholder,cancel,open,submit,goBack,default}
palette.{empty,group.commands}
dialog.{provider.search.placeholder,model.search.placeholder,directory.search.placeholder}
home.sessions.{search.placeholder,search.sessions}
session.{header.searchFiles,new.workspace.triggerLocal,header.open.copyPath,header.open.app.zed,tab.review}
sidebar.help
settings.{providers.title,general.section.appearance,general.row.showFileTree.title}
model.tag.free
model.tooltip.reasoning
context.stats.{totalTokens,inputTokens,outputTokens,reasoningTokens,cacheTokens}
context.usage.tokens
theme.scheme.{dark,light,system}
language.en
status.popover.trigger
titlebar.update
error.page.action.restart
toast.update.title
notification.permission.title
mcp.status.failed
prompt.example.{1,2,3}
provider.connect.{method.apiKey,oauth.code.placeholder}
```

The manifest is checked against all current TUI dictionaries (`ui.ts`,
`session.ts`, `settings.ts`, and `application.ts`) by matching their English
keys to upstream `en.ts`, then requiring the same upstream key to exist in
`zh.ts`, `es.ts`, `ko.ts`, and `fr.ts`. Current audit result: 77 exact reuses,
zero case adaptations, and zero authored entries in `catalog.ts`.

## Deliberate exclusions

`Parent` and `Next` are excluded because upstream has multiple meanings for
each (directory navigation versus generic flow). `New worktree` is excluded
because upstream's translation says workspace/tree inconsistently with the
TUI's product term. `Notifications` and `No items available` are also not in
the catalog: upstream does not provide all four locale values for those exact
English sources. The owning manual dictionary should retain or author them.

Matching manual duplicates are removed in favor of the audited upstream values.
Do not expand this file with desktop-only entries merely because they exist upstream.

When updating upstream, change the pinned SHA and all five source paths here,
rerun the four-locale and placeholder audit, and update the manifest with any
new exact reuse.
