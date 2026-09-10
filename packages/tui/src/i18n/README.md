# TUI language plugins

Interface languages are ordinary TUI plugins. The host provides English defaults,
lookup, interpolation and a per-TUI reactive registry. Bundled Chinese, Spanish,
Korean and French live under `src/feature-plugins/languages/` and register through
the same `context.i18n` API as external plugins.

## Add a language

Create `.redsun/plugins/language-de/tui.ts` and a dictionary beside it:

```ts
import { Plugin } from "@opencode/plugin/tui"
import messages from "./messages.json"

export default Plugin.define({
  id: "community.language.de",
  setup(context) {
    context.i18n.register({
      locale: "de",
      name: "German",
      nativeName: "Deutsch",
      catalogs: { tui: messages },
    })
  },
})
```

`messages.json` can start with a partial translation:

```json
{
  "settings.language.title": "Sprache der Benutzeroberfläche",
  "session.usage.cache": "Cache {{percent}} %",
  "session.subagents.view": {
    "plural": "count",
    "forms": {
      "one": "{{count}} Unteragent anzeigen",
      "other": "{{count}} Unteragenten anzeigen"
    }
  }
}
```

The language appears in `/language`. Local helper imports reload through the
existing plugin source watcher. For a published package, export `./tui` and add
its package name to `cli.json`'s `plugins` array using normal TUI plugin packaging.
The language API is a redsun extension; a host must expose `context.i18n`.

```json
{
  "plugins": ["redsun-language-de"],
  "language": "de"
}
```

That package name is illustrative. Put a local pack in the global config's
`plugins/<name>/tui.ts` directory for availability across projects. Project-local
packs follow the existing project discovery scope.

## API and lifecycle

Types are exported from `@opencode/plugin/tui/i18n`:

- `register({locale, name?, nativeName?, fallback?, catalogs})` returns an
  idempotent disposer. Contributions also dispose with their plugin activation.
- `locale()` reads the requested locale, reactively.
- `languages()` reads canonical locale IDs, English/native names, availability
  and contributing plugin IDs. The unavailable requested locale remains listed.
- `t("tui:settings.language.title", values?)` translates a fully qualified key.
- `diagnostics()` exposes invalid and unmatched entries with plugin, locale and
  key. `/plugins` also displays these in each TUI plugin's row details.

Supply `name` and `nativeName` together to introduce a language. Omit them when
contributing another dictionary for an already-described locale. Catalog-only
contributions stay dormant until a descriptor exists. Metadata and individual
message overrides use the existing resolved plugin order, then registration order
within a plugin; the last valid entry wins. Reloading a plugin preserves its place.
Removing an overlay restores the previous entry. Malformed/empty entries are
skipped with diagnostics, while malformed registration structures fail setup.

Setup stages contributions; they publish after the serialized lifecycle operation
settles. Failed reloads use the existing last-good restoration path. The published
language snapshot stays available during the swap. Old activation callbacks and
disposers cannot register into a replacement generation.

`cli.json` accepts well-formed locale tags, independent of installation. Missing or
disabled selected packs render English and retain the requested preference.
Reactivation restores the language. Explicit fallback chains may connect regional
variants, e.g. `pt-BR` with `fallback: "pt"`; no sibling/script guessing is done.
Cycles terminate at English. English host defaults are always available and cannot
be overridden or disabled. Other UI plugins register their own namespace's English
defaults through `register({locale: "en", catalogs: {"my.plugin": defaults}})`.
Language packs may translate any named UI namespace. Unknown source keys are
nonfatal diagnostics and are revalidated when their source namespace arrives.

## Message contract

`manifest.json` is the version-1 source contract: stable message IDs, English
defaults, context and upstream provenance. IDs remain unchanged for compatible
copy edits. A different meaning or incompatible parameters require a new ID.
Record deprecation mappings before removing published IDs.

Messages are strings or `{plural, forms}`. Parameters use `{{name}}`. Inserted
values are string/number data and are interpolated once, never translated. Plural
selectors require finite numeric values. `Intl.PluralRules` uses the locale of the
chosen translation; a fallback message uses its own locale's rules. `other` is
required, and `zero`, `one`, `two`, `few`, and `many` are optional. Missing forms
use `other`. Unsupported plural locales or malformed count inputs fall back to
English; an absent count remains visible as a placeholder. Plural forms may omit
the count placeholder for natural wording such as "No items". Other required
parameters must be preserved. Full ICU syntax and terminal bidirectional layout
are not implied by accepting a locale tag.

External UI components call `context.i18n.t()` in JSX/accessors so switching stays
live. Internal TUI components use `useLanguage().t()` with IDs scoped to `tui`.
The source manifest retains legacy English lookup aliases only for internal
authored command/settings metadata; external catalogs key by stable ID. Formatting
helpers receive a translator; their standalone default is English. Generic dialog
props, model messages, user content, credentials and tool output stay verbatim.

## Author tools

From `packages/tui`:

```sh
bun run i18n:manifest
bun run i18n:template > messages.json
bun run i18n:check de messages.json
```

The template contains English defaults to translate or remove. Validation reports
translated/total counts, missing IDs, invalid messages and unmatched newer keys.
Partial catalogs and unmatched keys are accepted; invalid messages produce a
nonzero exit status. Shape/parameter validation does not assess translation quality.

## Upstream reuse and maintenance

Provenance records preserve 77 exact upstream translation reuses and seven semantic
adaptations from commit `20aff6d9f643afe9abf8a048e68f019d049f5329`, using
`packages/app/src/runtime/i18n/{en,zh,es,ko,fr}.ts`. Chinese upstream is `zh.ts`.
`upstream.match` distinguishes exact and semantic reuse. The migration preserved
all 2,336 prior translated values, including the eight singular/plural pairs.
Review shared meanings before reusing entries; see `GLOSSARY.md` for terminology.

Builtin language catalogs must cover the source manifest completely. Community
catalogs may be partial. Update the manifest, relevant locale files and provenance
together; never regenerate IDs from edited English text.

```sh
bun test test/i18n.test.ts test/i18n-registry.test.ts test/i18n-terminology.test.ts
bun test test/language-plugin-lifecycle.test.tsx test/language-lifecycle.test.tsx
bun test test/component/dialog-language.test.tsx test/component/dialog-backdrop.test.tsx
```

The lifecycle tests load an actual local plugin through discovery, including
helper-file hot reload, failed setup restoration, unregister and stale callbacks.
CLI `test/config.test.ts` covers persisted `cli.json` preferences.
