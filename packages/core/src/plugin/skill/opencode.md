# redsun

Use this guide as the starting point for work involving redsun itself. It
covers the core concepts needed to configure and customize redsun, extend it
with plugins, and build integrations with its clients and API.

redsun is a fork of OpenCode V2 and keeps its configuration schema, plugin API,
and HTTP API. Upstream documentation at <https://opencode.ai/v2/docs/> is
therefore the source of truth for field names, shapes, and behavior. This
overview is only an index of core concepts. Before answering a question about a
topic below, fetch the URL named in that section and use the full page as the
reference. Follow links from that page when the question needs more detail.
Fetch <https://opencode.ai/v2/docs/> first when you need to discover the
relevant documentation page.

## Naming differences from upstream

The upstream docs use OpenCode's own names. Translate them when answering:

| Upstream | redsun |
| --- | --- |
| `opencode` binary | `redsun` |
| `opencode.json` / `opencode.jsonc` | `redsun.json` / `redsun.jsonc` |
| `.opencode/` project directory | `.redsun/` |
| `~/.config/opencode/` | `~/.config/redsun/` |
| `~/.local/share/opencode/` | `~/.local/share/redsun/` |

Environment variables keep the `OPENCODE_*` prefix for compatibility, and
configuration files still carry the upstream `$schema` URL. Never present a
path or command in upstream spelling; a user following it will not find the
file.

## Version policy

redsun tracks OpenCode V2. Always answer for V2 unless the user explicitly
asks about V1, legacy OpenCode, redsun v0.3.x, or migrating from V1.

Use only <https://opencode.ai/v2/docs/> documentation as the source of truth for V2.
Do not use <https://opencode.ai/docs/>, which documents V1, and do not use
general web search to resolve a V2 documentation question when the V2 docs or
linked pages cover it. The schema served from
<https://opencode.ai/config.json> may describe V1 even though V2 configuration
files include that URL for editor integration. Never use it to infer V2 field
names or shapes. If V2 documentation is missing or contradictory, state the
uncertainty or ask for clarification instead of falling back to V1.

V1 documentation and syntax may be consulted only when the user explicitly
asks about V1 or when needed as migration input. Outputs and recommendations
must still use V2 unless the user specifically requests a V1 result.

## [CLI](https://opencode.ai/v2/docs/cli)

For questions about the terminal interface, command-line invocation, `run`,
`mini`, terminal providers, or other CLI behavior, fetch the
[CLI guide](https://opencode.ai/v2/docs/cli) and the relevant page linked from
that section.

CLI and TUI preferences are separate from redsun's server and project
configuration. They live in the global `~/.config/redsun/cli.json`, or
`$XDG_CONFIG_HOME/redsun/cli.json` when `XDG_CONFIG_HOME` is set. There is no
project-local CLI configuration. Most preferences can also be changed from the
TUI by pressing `Ctrl+P` and selecting **Open settings**.

Fetch the full [CLI configuration guide](https://opencode.ai/v2/docs/cli/config)
before editing `cli.json`. It covers terminal-only settings such as themes,
keybindings, terminal plugins, scrolling, attention alerts, diff presentation,
and terminal integration. Do not put these settings in `redsun.json(c)`.

### [Keybinds](https://opencode.ai/v2/docs/cli/keybinds)

Configure keybindings under `keybinds` in `cli.json`. The leader key is the
`keybinds.leader` entry; leader timing is configured separately under
`leader.timeout`. Bindings can use a string, an array of strings, or an object
when event behavior such as `preventDefault` is required. Disable a binding
with `"none"` or `false`.

Never guess a command ID, default binding, or accepted key syntax. Fetch the
full [keybind reference](https://opencode.ai/v2/docs/cli/keybinds), which lists
the current IDs and defaults, before answering or editing a binding.

## [Configuration](https://opencode.ai/v2/docs/config)

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

When redsun starts, it searches from the current directory up to the project
root. It merges direct `redsun.json(c)` files from root to current directory,
then does the same for `.redsun/redsun.json(c)` files. This means every
`.redsun` config overrides every direct config. Global configuration has the
lowest precedence.

Common configuration fields include `model`, `default_agent`, `permissions`,
`agents`, `commands`, `plugins`, `providers`, `mcp`, `skills`, `instructions`,
`references`, `formatter`, and `lsp`.

This configuration is distinct from `cli.json`. Use the
[CLI configuration guide](https://opencode.ai/v2/docs/cli/config) for terminal
preferences, especially themes and keybindings.

Do not guess field names or shapes. Fetch the V2 configuration guide and its
linked topic guide as the source of truth, and preserve unrelated settings when
editing an existing file. Keep the published `$schema` URL in configuration
examples, but do not fetch it to determine the V2 configuration shape.

See the [full configuration guide](https://opencode.ai/v2/docs/config) for
every field, examples, config locations, and links to dedicated feature guides.

## [MCP servers](https://opencode.ai/v2/docs/mcp-servers)

Configure MCP servers under `mcp.servers`. Prefer the CLI because it preserves
unrelated configuration. Use `--global` when the user asks to set up a service
for themselves without limiting it to the current project; omit it when they
explicitly want project-local configuration.

```sh
redsun mcp add <name> --global --url <remote-url>
redsun mcp list
```

Remote servers use OAuth by default. If `mcp list` reports that a server needs
authentication, run the OAuth flow and then verify the connection:

```sh
redsun mcp auth <name>
redsun mcp list
```

The auth command prints an authorization URL, waits for the browser redirect,
and stores credentials outside the redsun configuration. Do not ask for or
store an API key when the server supports OAuth. Use header-based credentials
only when OAuth is unavailable or the user explicitly requires them, and use an
environment substitution such as `{env:MCP_API_KEY}` instead of writing a
secret into configuration.

## [V1 to V2 migration](https://opencode.ai/v2/docs/migrate-v1)

redsun v0.3.x was built on OpenCode V1, so migrating from it is an OpenCode
V1 to V2 migration. For any request to migrate configuration, agents, commands,
skills, plugins, integrations, or other behavior from V1 to V2, read the full
[migration guide](https://opencode.ai/v2/docs/migrate-v1) before acting. In
the repository, its source is `packages/www/src/docs/content/migrate-v1.mdx`.

V1 config files and `.redsun/` definitions are intended to remain compatible.
The only intentional breaking changes are the server API and plugin API. Native
V2 config uses more ergonomic shapes, but conversion is optional. When the user
requests conversion, inspect the complete configuration, preserve behavior and
unrelated settings, and apply only the relevant migrations from the guide. For
plugin migrations, fetch and follow both the migration guide and the full
[plugins guide](https://opencode.ai/v2/docs/build/plugins). If non-API V1
functionality fails in V2, use the `report` skill to file it as a compatibility
bug.

## [Plugins](https://opencode.ai/v2/docs/build/plugins)

For questions about creating, configuring, loading, publishing, or migrating
plugins, fetch the full [plugins guide](https://opencode.ai/v2/docs/build/plugins)
before answering. This includes questions about the Effect plugin API, hooks,
transforms, tools, plugin context capabilities, and package entrypoints.

## [Service](https://opencode.ai/v2/docs/troubleshooting#check-the-background-service)

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

## [API](https://opencode.ai/v2/docs/api)

redsun exposes an HTTP API from its server. The API is described by an
OpenAPI document available from the running server at `/openapi.json`.

Use redsun's built-in `api` command for local requests. It uses the same
discovery and authentication flow as the TUI and may start the background
service when no compatible healthy service is available. It accepts either an
HTTP method and path or an OpenAPI operation ID.

Call an endpoint with an HTTP method and path:

```sh
redsun api get /api/health
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

See the [full API reference](https://opencode.ai/v2/docs/api) for available
endpoints, parameters, request bodies, and response schemas. The
raw [OpenAPI specification](https://opencode.ai/v2/openapi.json) is also
available for code generation and other tooling.

## [Client](https://opencode.ai/v2/docs/build/client)

For questions about connecting an application to redsun over the network,
fetch the full [client guide](https://opencode.ai/v2/docs/build/client) before
answering.

`@opencode-ai/client` is the generated TypeScript client for the HTTP API,
which redsun serves unchanged. Its methods and types come from the same contract as the API reference.
The default entrypoint exposes Promise-based resource clients and async
iterables for streaming endpoints. The `@opencode-ai/client/effect` entrypoint
exposes typed Effects, Streams, and decoded schema values. Its
`Service` API can discover, start, stop, and authenticate with the local
background service from a Node application.

## [Troubleshooting](https://opencode.ai/v2/docs/troubleshooting)

redsun runs a client and a background server. Start by determining whether a
problem belongs to the client, the shared server, or one project.

- Check the service with `redsun service status` and verify the API with
  `redsun api get /api/health`.
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

See the [full troubleshooting guide](https://opencode.ai/v2/docs/troubleshooting)
for service lifecycle commands, API inspection, log locations, explicit server
connections, issue-reporting details, and local development paths.
