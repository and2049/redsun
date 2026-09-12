# Commands

Every command accepts `--help` for its full flag list, for example `redsun run --help`. Commands that talk to a server also accept `--standalone` to run a private server and `--server <url>` to target a specific one.

## run

`redsun run` sends a message and prints the reply without opening the interactive interface.

```bash
$ redsun run "Explain this repository"
```

### CI

In CI, pass a provider API key as a secret and use standalone mode so the private server receives it. For example, this GitHub Actions job reviews the checked-out repository:

```yaml
name: redsun review
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install --global @opencode/cli
      - run: redsun run --standalone --model anthropic/claude-sonnet-4-5 "Review this repository for correctness and summarize any issues."
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Choose a model.

```bash
$ redsun run --model anthropic/claude-sonnet-4-5 "Refactor parseToken"
```

Continue the last session.

```bash
$ redsun run --continue "Now handle the expired case"
```

Emit newline-delimited JSON for scripts.

```bash
$ redsun run --format json "List the TODO comments"
```

Attach files to the message.

```bash
$ redsun run --file src/server.ts --file src/client.ts "Review these for bugs"
```

Run with a specific agent.

```bash
$ redsun run --agent build "Fix the failing test"
```

View all subcommands and flags.

```bash
$ redsun run --help
```

## mini

`redsun mini` starts the minimal interactive interface instead of the full-screen TUI.

```bash
$ redsun mini
```

Continue the last session.

```bash
$ redsun mini --continue
```

Start with a model and an initial prompt.

```bash
$ redsun mini --model anthropic/claude-sonnet-4-5 --prompt "Summarize this repository"
```

View all subcommands and flags.

```bash
$ redsun mini --help
```

## session

`redsun session` manages sessions.

```bash
$ redsun session list
```

Limit the list and print JSON.

```bash
$ redsun session list --max-count 20 --format json
```

Delete a session and its child sessions.

```bash
$ redsun session delete ses_9c1b08
```

Export session data as JSON.

```bash
$ redsun session export ses_4f2a1c
```

Redact sensitive transcript and file data when exporting.

```bash
$ redsun session export ses_4f2a1c --sanitize
```

Import session data from a JSON file or URL.

```bash
$ redsun session import session.json
```

Import into a specific directory.

```bash
$ redsun session import session.json --directory ~/code/project
```

View all subcommands and flags.

```bash
$ redsun session --help
```

## auth

`redsun auth` manages AI providers and credentials.

```bash
$ redsun auth list
```

List them as JSON.

```bash
$ redsun auth list --format json
```

Log in to a provider.

```bash
$ redsun auth login anthropic
```

Log in with a specific authentication method.

```bash
$ redsun auth login anthropic --method api-key
```

Log out of a saved account.

```bash
$ redsun auth logout anthropic work
```

Switch the active account for an integration.

```bash
$ redsun auth switch anthropic work
```

View all subcommands and flags.

```bash
$ redsun auth --help
```

## models

`redsun models` lists every available model.

```bash
$ redsun models
```

View all subcommands and flags.

```bash
$ redsun models --help
```

## mcp

`redsun mcp` manages MCP (Model Context Protocol) servers.

```bash
$ redsun mcp list
```

Add a remote server.

```bash
$ redsun mcp add context7 --url https://mcp.context7.com/mcp
```

Add a local server to the global config.

```bash
$ redsun mcp add everything --global -- npx -y @modelcontextprotocol/server-everything
```

Add a local server with an environment variable.

```bash
$ redsun mcp add everything --env LOG_LEVEL=debug -- npx -y @modelcontextprotocol/server-everything
```

Add a remote server with a header.

```bash
$ redsun mcp add context7 --url https://mcp.context7.com/mcp --header CONTEXT7_API_KEY=secret
```

Authenticate with an OAuth-capable remote server.

```bash
$ redsun mcp auth sentry
```

Remove stored OAuth credentials for a server.

```bash
$ redsun mcp logout sentry
```

View all subcommands and flags.

```bash
$ redsun mcp --help
```

## plugin

`redsun plugin` manages plugins.

```bash
$ redsun plugin list
```

Include built-in server plugins.

```bash
$ redsun plugin list --builtin
```

Install a plugin and add it to the global configuration.

```bash
$ redsun plugin add @example/opencode-tui
```

Check package plugins for updates.

```bash
$ redsun plugin check
```

Update package plugins.

```bash
$ redsun plugin update
```

Remove a plugin from global configuration.

```bash
$ redsun plugin remove @example/opencode-tui
```

View all subcommands and flags.

```bash
$ redsun plugin --help
```

## stats

`redsun stats` shows shareable usage statistics.

```bash
$ redsun stats
```

Show the last 7 days.

```bash
$ redsun stats --days 7
```

Show model usage.

```bash
$ redsun stats --models
```

Show cost and token details.

```bash
$ redsun stats --cost
```

Print JSON instead of a report.

```bash
$ redsun stats --json
```

View all subcommands and flags.

```bash
$ redsun stats --help
```

## serve

`redsun serve` starts the API and web server. See [Web](web.md).

```bash
$ redsun serve
```

Bind to all interfaces on a fixed port.

```bash
$ redsun serve --hostname 0.0.0.0 --port 4096
```

Allow a browser client from another origin.

```bash
$ redsun serve --cors https://app.example.com
```

View all subcommands and flags.

```bash
$ redsun serve --help
```

## pair

`redsun pair` shows server pairing information, including URLs, credentials, and a QR code.

```bash
$ redsun pair
```

Advertise an external URL in the QR code.

```bash
$ redsun pair --url https://dev.example.com
```

View all subcommands and flags.

```bash
$ redsun pair --help
```

## service

`redsun service` manages the background server. See [Web](web.md).

```bash
$ redsun service start
```

Restart it.

```bash
$ redsun service restart
```

Show its status.

```bash
$ redsun service status
```

Stop it.

```bash
$ redsun service stop
```

Read a setting.

```bash
$ redsun service get hostname
```

Set a setting.

```bash
$ redsun service set hostname 0.0.0.0
```

Allow an extra CORS origin.

```bash
$ redsun service set cors https://app.example.com
```

Pass an environment variable to the server process.

```bash
$ redsun service set env OPENCODE_LOG_LEVEL DEBUG
```

Reset a setting to its default.

```bash
$ redsun service unset hostname
```

View all subcommands and flags.

```bash
$ redsun service --help
```

## api

`redsun api` makes a request to the running server.

```bash
$ redsun api GET /api/session
```

Call an operation ID with a query parameter.

```bash
$ redsun api v2.session.list --param limit=10
```

Send a JSON body.

```bash
$ redsun api v2.session.create --data '{"title": "New session"}'
```

Add a request header.

```bash
$ redsun api GET /api/session -H "accept: application/json"
```

View all subcommands and flags.

```bash
$ redsun api --help
```

## acp

`redsun acp` starts an Agent Client Protocol server over stdin and stdout for editor integrations. It runs until the client closes the connection.

```bash
$ redsun acp
```

View all subcommands and flags.

```bash
$ redsun acp --help
```

## debug

`redsun debug` provides debugging and troubleshooting tools.

```bash
$ redsun debug agents
```

List configuration sources.

```bash
$ redsun debug config
```

Show global paths.

```bash
$ redsun debug paths
```

Print a single path.

```bash
$ redsun debug paths db
```

View all subcommands and flags.

```bash
$ redsun debug --help
```

## upgrade

`redsun upgrade` upgrades redsun to the latest or a specific version. Alias: `update`.

```bash
$ redsun upgrade
```

Upgrade to a specific version with a specific package manager.

```bash
$ redsun upgrade 1.18.15 --method bun
```

View all subcommands and flags.

```bash
$ redsun upgrade --help
```

## uninstall

`redsun uninstall` removes redsun and all related files.

```bash
$ redsun uninstall
```

Preview what would be removed.

```bash
$ redsun uninstall --dry-run
```

Keep configuration and session data.

```bash
$ redsun uninstall --keep-config --keep-data
```

View all subcommands and flags.

```bash
$ redsun uninstall --help
```
