# redsun

Use this guide as the starting point for work involving redsun itself. It
covers the core concepts needed to configure and customize redsun, extend it
with plugins, and build integrations with its clients and API.

redsun is a fork of OpenCode V2 and keeps its configuration schema, plugin API,
and HTTP API. The full documentation is installed locally, already
translated to redsun naming, under:

{{DOCS_DIR}}

Before answering a question about a topic below, read the page named in that
section with the `read` tool and use the full page as the reference. Follow
relative links inside a page when the question needs more detail. Every page
also exists online at <https://opencode.ai/v2/docs/> under the same path
without the `.md` suffix; use the online copy only when the local file is
missing or the user asks for the newest upstream version. The online copy uses
upstream naming, so translate it with the table below.

## Page map

Paths are relative to the docs directory above and end in `.md`. The sections
below name the page for their topic; the other pages are:

- Top level: `agents`, `commands` (custom commands, prompt templates), `skills`,
  `instructions` (AGENTS.md), `references` (directories outside the project),
  `permissions`, `providers`, `models`, `tools`, `websearch`, `formatters`,
  `attachments`, `compaction`, `snapshots` (rollback), `sharing`, `warming`
  (session warming), `themes`, `network` (proxies, certificates)
- `cli/`: `commands` (command-line options), `providers`, `plugins`, `theme`,
  `tui`, `web` (server access and pairing), `acp`
- `build/`: `index`, `plugins/effect`, `plugins/effect/rpc`, `client/effect`

Not vendored: the HTTP API reference, which is generated from the running
server's `/openapi.json`, and the OpenCode Console pages, which describe an
upstream hosted service.

Upstream features redsun deliberately does not carry, even though the vendored
pages still describe them: the `session.panel` slot and `ui.panel` API in
`build/plugins/cli.md` (redsun has no session panes), and session tabs, whose
`ui.tabs` methods exist but always report disabled. Do not build on either.
The upstream `session.permissions` CLI preference is also absent: redsun uses
the server-side auto-approve toggle (`Shift+Tab`), which applies across sessions.
Per-session permission rules in the server API are supported.

## Naming differences from upstream

The local pages already use redsun names. The upstream site and the upstream
repository use OpenCode's own names. Translate them when reading online
material or answering from memory:

| Upstream                           | redsun                         |
| ---------------------------------- | ------------------------------ |
| `opencode` binary                  | `redsun`                       |
| `opencode.json` / `opencode.jsonc` | `redsun.json` / `redsun.jsonc` |
| `.opencode/` project directory     | `.redsun/`                     |
| `~/.config/opencode/`              | `~/.config/redsun/`            |
| `~/.local/share/opencode/`         | `~/.local/share/redsun/`       |

Environment variables keep the `OPENCODE_*` prefix for compatibility, package
names keep the `@opencode/` scope, and configuration files still carry the
upstream `$schema` URL. Never present a path or command in upstream spelling; a
user following it will not find the file.

## Sources

The local pages and <https://opencode.ai/v2/docs/> are the only sources of
truth; do not use web search when they cover the question. Do not use <https://opencode.ai/docs/> (a different, older product) or
the schema at <https://opencode.ai/config.json> to infer field names or shapes;
if the pages are missing or contradictory, say so instead of guessing.

## CLI

For questions about the terminal interface, command-line invocation, `run`,
terminal providers, or other CLI behavior, read `cli/index.md` and the page it
links to.

CLI and TUI preferences are separate from redsun's server and project
configuration. They live in the global `~/.config/redsun/cli.json`, or
`$XDG_CONFIG_HOME/redsun/cli.json` when `XDG_CONFIG_HOME` is set. There is no
project-local CLI configuration. Set `OPENCODE_CLI_CONFIG_CONTENT` to merge
inline JSON over the global settings. Most preferences can also be changed from
the TUI by pressing `Ctrl+P` and selecting **Open settings**.

Read `cli/config.md` before editing `cli.json`. It covers terminal-only
settings such as themes, keybindings, terminal plugins, scrolling, attention
alerts, diff presentation, and terminal integration. Do not put these settings
in `redsun.json(c)`.

### Keybinds

Configure keybindings under `keybinds` in `cli.json`. The leader key is the
`keybinds.leader` entry; leader timing is configured separately under
`leader.timeout`. Bindings can use a string, an array of strings, or an object
when event behavior such as `preventDefault` is required. Disable a binding
with `"none"` or `false`.

Never guess a command ID, default binding, or accepted key syntax. Read
`cli/keybinds.md`, which lists the current IDs and defaults, before answering
or editing a binding.

## Configuration

redsun's server and project configuration uses JSON or JSONC. Include the
upstream schema so the user's editor can validate fields and provide
autocomplete:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
}
```

Global configuration lives at `~/.config/redsun/redsun.json(c)` and applies
to every project for that user. Project configuration can live in any directory
as `redsun.json(c)` or `.redsun/redsun.json(c)`, including nested packages
in a monorepo.

During ordinary project discovery, redsun searches the current Location
directory and every ancestor through the filesystem root, including directories
above the detected project or repository root. It merges direct
`redsun.json(c)` files from the farthest ancestor to the current directory,
then does the same for `.redsun/redsun.json(c)` files. This means every
discovered `.redsun` config overrides every discovered direct config. Global
filesystem configuration has lower precedence than these discovered documents.

Common configuration fields include `model`, `default_agent`, `permissions`,
`agents`, `commands`, `plugins`, `providers`, `mcp`, `skills`, `instructions`,
`references`, `formatter`, and `lsp`.

This configuration is distinct from `cli.json`. Use `cli/config.md` for
terminal preferences, especially themes and keybindings.

Do not guess field names or shapes. Read `config.md` and the topic page it
links to as the source of truth, and preserve unrelated settings when editing
an existing file. Keep the published `$schema` URL in configuration examples,
but do not fetch it to determine the configuration shape.

## MCP servers

Configure MCP servers under `mcp.servers`. Read `mcp-servers.md` for the full
shape. Prefer the CLI because it preserves unrelated configuration. Use
`--global` when the user asks to set up a service for themselves without
limiting it to the current project; omit it when they explicitly want
project-local configuration.

```sh
redsun mcp add <name> --global --url <remote-url>
redsun mcp list
```

Remote servers use OAuth by default. If `mcp list` reports that a server needs
authentication, tell the user to run `/mcps`, select the server, and sign in.
Do not run `redsun mcp auth` through the shell tool: it starts an interactive
flow whose authorization link can be hidden in background process output.
Use the user-facing MCP interface instead.

Report the server as configured but awaiting sign-in until its connection
status confirms it is connected.

OAuth credentials are stored outside the redsun configuration. Do not ask for or
store an API key when the server supports OAuth. Use header-based credentials
only when OAuth is unavailable or the user explicitly requires them, and use an
environment substitution such as `{env:MCP_API_KEY}` instead of writing a
secret into configuration.

## Plugins

For questions about creating, configuring, loading, or publishing plugins,
read `build/plugins/index.md` in full before answering. It covers
hooks, transforms, tools, plugin context capabilities, and package entrypoints.
Installing and enabling plugins in `redsun.json(c)` is covered by `plugins.md`.
Plugins can also extend the TUI; for those, read `build/plugins/cli.md`, which
documents the commands, keymap layers, routes, tabs, dialogs, toasts, markdown
renderers, and the slot paths a TUI plugin can claim. For custom methods and
events shared with other plugins or clients, read `build/plugins/rpc.md`.

When modifying redsun's own source rather than writing a plugin, the same pages
describe the plugin domains and TUI slots that redsun's built-in features are
implemented against, so read them first and then follow the corresponding
`packages/core/src/plugin/` or `packages/tui/src/feature-plugins/` code.

## Service

redsun uses a client-server architecture. Interfaces such as the TUI connect
to a background redsun service, which owns sessions, configuration, plugins,
permissions, and tool execution.

redsun normally discovers or starts the shared background service
automatically. If the service is stuck or unhealthy, restart it:

```sh
redsun service restart
```

Check its status after restarting:

```sh
redsun service status
```

## API

redsun exposes an HTTP API from its server. The API is described by an
OpenAPI document available from the running server at `/openapi.json`. The
API reference is not vendored locally; read `/openapi.json` from the running
server, or the online reference at <https://opencode.ai/v2/docs/api>.

Use redsun's built-in `api` command for local requests. It uses the same
discovery and authentication flow as the TUI and may start the background
service when no compatible healthy service is available. It accepts either an
HTTP method and path or an OpenAPI operation ID.

Call an endpoint with an HTTP method and path:

```sh
redsun api get /api/info
```

Pass a request body with `--data` or `-d`, and additional headers with
`--header` or `-H`:

```sh
redsun api post /api/example --data '{"key":"value"}'
redsun api get /api/example --header 'X-Example:value'
```

Request bodies default to `Content-Type: application/json`. When redsun is
connected to an explicit server instead of its managed background service, use
the same configured server and authentication context rather than constructing
an unauthenticated request separately.

## Client

For questions about connecting an application to redsun over the network,
read `build/client/index.md` before answering.

`@opencode/client` is the generated TypeScript client for the HTTP API,
which redsun serves unchanged. Its methods and types come from the same contract as the API reference.
The default entrypoint exposes Promise-based resource clients and async
iterables for streaming endpoints. The `@opencode/client/effect` entrypoint
exposes typed Effects, Streams, and decoded schema values. Its
`Service` API can discover, start, stop, and authenticate with the local
background service from a Node application.

## Troubleshooting

redsun runs a client and a background server. Start by determining whether a
problem belongs to the client, the shared server, or one project.

- Check the service with `redsun service status` and verify the API with
  `redsun api get /api/info`.
- Compare with `redsun --standalone`, which runs the TUI with a private
  server, to isolate shared-service issues.
- Inspect `~/.local/share/redsun/log/opencode.log`. Filter `role=cli` for
  client startup and `role=server` for sessions, providers, plugins,
  permissions, and tools.
- Run one reproduction with `OPENCODE_LOG_LEVEL=DEBUG` when normal logs are not
  sufficient.
- Do not delete or edit the database, service registration, or service config
  while diagnosing a problem. Back up persistent data before inspecting it
  with external tools.
- Redact API keys, authorization headers, prompts, file contents, and other
  sensitive data before sharing diagnostics.

See `troubleshooting.md` for service lifecycle commands, API inspection, log
locations, explicit server connections, issue-reporting details, and local
development paths.
