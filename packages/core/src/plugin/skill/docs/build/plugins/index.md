# Overview

Plugins modify redsun's behavior and add new features. A plugin is one package with a server part, a TUI part, a GUI
part, or any combination.

```ts title=".redsun/plugins/example/index.ts"
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    await ctx.storage.set("loaded", true)
  },
})
```

## Parts

Each part is an export of the package. Every part's SDK comes from the one `@opencode/plugin` dependency.

```json title="package.json"
{
  "name": "opencode-acme-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx",
    "./rpc": "./src/rpc.ts"
  },
  "files": ["src", "dist"],
  "dependencies": {
    "@opencode/plugin": "latest"
  }
}
```

- **Server** (`.` or `./server`) runs in the redsun server with `@opencode/plugin`. It adds tools, hooks,
  integrations, commands, and agents. See [Server](server.md), or [Effect plugins](effect.md)
  for the Effect API.
- **TUI** (`./tui`) runs in the terminal UI with `@opencode/plugin/tui`. See [TUI](cli.md).
- **RPC** (`./rpc`) is a typed contract that the server part implements and the other parts and clients call. See
  [RPC](rpc.md).

The plugin's `id` comes from its server part's `Plugin.define`. A package with a GUI part and no server part takes its
package name (or a local directory's name) as its `id`. A TUI part declares its own `id`; a GUI part declares none and
takes the plugin's.

## Load

Plugins under `.redsun/plugins/` load automatically, like the local example above. To load published packages or
plugin directories from other locations, add them to `plugins` in `redsun.json(c)`:

```jsonc title="redsun.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-acme-plugin",
    "opencode-acme-plugin@1.2.0",
    "@acme/opencode-plugin",
    "./plugins/local",
    "../shared/plugin",
    "/absolute/path/plugin",
    "file:///home/me/plugins/local",
    {
      "package": "@acme/opencode-plugin",
      "options": {
        "agent": "reviewer",
        "strict": true,
      },
    },
  ],
}
```

- One entry loads every part. The TUI loads the TUI parts of the plugins its server loads.
- A package with only a TUI part goes in [`cli.json`](../../cli/plugins.md) instead.
- A local plugin directory with a `package.json` `name` and `exports` loads its parts through them, like the published
  package. Without them, it uses file names at its root: `server` (else `index`), `tui`, and `rpc` with a `.ts`,
  `.tsx`, or `.js` extension.
- See [Configure plugins](../../plugins.md) for more loading and configuration options.

## Publish

A published plugin is an npm package with the `package.json` above. Its parts use the same default exports as a local
plugin.

```bash
npm publish
```

- Export `./rpc` when other plugins and clients should import your [RPC contract](rpc.md) without loading
  your implementation.
- Use versions compatible with the redsun release you target, and test the installed package, not only a
  workspace-linked copy. Publish a compatible plugin update when you adopt a newer API contract.

- [Server](server.md): Add tools, hooks, integrations, commands, and agents in the redsun server.
- [TUI](cli.md): Add commands, routes, slots, and Markdown renderers to the terminal UI.
- [RPC](rpc.md): Expose typed methods and events from the server part to the other parts and to clients.
