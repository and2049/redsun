# TUI plugin API

A TUI plugin is a module whose default export is `Plugin.define({ id, api, setup })`.
Redsun resolves it from a package's `./tui` export or from a directory containing
`tui.ts`/`tui.tsx`. The Bun build of redsun compiles `.tsx` plugin directories at load time
and aliases `@opencode/plugin/tui`, `@opentui/solid`, `@opentui/core`, `solid-js` and
`solid-js/store` to the host's copies, so a plugin needs no dependencies of its own.

```ts
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "example.skin",
  api: 1,
  setup(context) {
    context.ui.slot({ replace: "home.logo", render: () => <text>Example</text> })
  },
})
```

## Loading a plugin

| Source                                                               | Behaviour                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `<config dir>/plugins/<name>/` and project `.redsun/plugins/<name>/` | Discovered and hot reloaded                                                          |
| `cli.json` `plugins: ["<spec>", "-<id>", { package, options }]`      | Ordered enable and disable directives, npm specs, local paths                        |
| Server plugins with `features.tui`                                   | Loaded when active                                                                   |
| `redsun --plugin <spec>` (repeatable)                                | Appended after the config entries for this process only; never written to `cli.json` |

`redsun --client <name>` sets `context.app.name`, the terminal title and the telemetry
client tag for the launch. `OPENCODE_CLIENT` remains the environment fallback.

## API version

`Plugin.API` is the version the host implements. A plugin declaring a newer `api` fails
setup with an error naming both numbers; the entry shows as failed in `/plugins`. Omitting
`api` skips the check.

| Version | Adds                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `home.logo`, `home.backdrop`, `context.vim`, `context.themes`, `context.ui.dimensions`, `context.app.name`, launch-scoped plugins |

## Slots

`context.ui.slot(claim)` takes exactly one placement key (`prepend`, `append`, `before`,
`after`, `replace`) naming a path. `replace` takes over the host content inside the
boundary; siblings placed `before` and `after` still render. The render function receives
the slot's input reactively.

| Path                                                          | Input                                 | Host content                                           |
| ------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `app`                                                         | none                                  | The whole app                                          |
| `home.backdrop`                                               | `{ width, height }` of the home route | Empty absolute box behind the home route at z-index -1 |
| `home.footer`                                                 | none                                  | Plugin, MCP, directory and version row                 |
| `home.logo`                                                   | none                                  | The redsun logo                                        |
| `prompt.footer`, `prompt.footer.status`, `prompt.footer.file` | `{ sessionID?, mode, showDetails }`   | Prompt meta rows                                       |
| `session.composer.top`                                        | `{ sessionID }`                       | Above the session composer                             |
| `sidebar.content`, `sidebar.footer`                           | `{ sessionID }`                       | Session sidebar                                        |

## Context

| Member                                   | Meaning                                                         |
| ---------------------------------------- | --------------------------------------------------------------- |
| `app.name`, `app.version`, `app.channel` | Launch identity                                                 |
| `vim.mode`                               | `insert`, `normal` or `command`; reactive                       |
| `ui.dimensions()`                        | Terminal `{ width, height }`; reactive                          |
| `theme`, `themeMode`                     | Resolved tokens of the active theme                             |
| `themes.register(name, document)`        | Adds a theme document (v1 flat or v2); returns a disposer       |
| `themes.select(name)`                    | Activates a registered theme for this process without saving it |
| `themes.current()`                       | Active theme name; reactive                                     |
| `themes.lock()`                          | Holds the active theme; returns a release function              |
| `themes.locked()`                        | Whether any lock is held; reactive                              |

Everything registered during setup is disposed when the plugin deactivates: themes are
removed, locks released, slots and routes unregistered.

## Lock semantics

While a lock is held:

- `config.theme.name` is ignored, including later config reloads.
- The `theme.switch` command disappears from the palette and slash completion.
- The Theme row leaves the settings dialog.
- The theme switcher's `set` becomes a no-op.
- `themes.select` from a plugin still works.

`select` and `lock` never write `cli.json`, so the theme saved for plain redsun launches
survives. Releasing the last lock re-applies the configured theme.

A skin that follows the vim mode selects its theme from an effect inside a rendered slot,
not from setup, because setup runs outside any Solid owner:

```tsx
context.ui.slot({
  append: "home.backdrop",
  render: (input) => {
    createEffect(() => context.themes.select(context.vim.mode === "insert" ? "cool" : "warm"))
    return <Crescent width={input.width} height={input.height} />
  },
})
```

The contract is pinned by `packages/tui/test/skin-plugin.test.tsx`, which loads
`packages/tui/test/fixture/skin` through `--plugin` semantics and exercises every row above.
