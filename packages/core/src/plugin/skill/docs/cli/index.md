# Intro

Run the CLI in a project to open the full-screen terminal interface:

```bash
redsun
```

Pass a directory to work in a different project:

```bash
redsun ~/code/my-project
```

Suggested terminals:

- [Ghostty](https://ghostty.org)
- [WezTerm](https://wezterm.org)
- [Alacritty](https://alacritty.org)
- [Kitty](https://sw.kovidgoyal.net/kitty/)

Truecolor support gives themes their most accurate colors; terminals without it use an approximation of the available
palette.

## Automation

Use `redsun run` to submit a prompt without opening the interactive interface. It is designed for scripts, CI jobs, and
other workflows that need model output directly in the terminal.

```bash
redsun run "Explain this repository"
```

## Mini

Use `redsun mini` to start redsun's minimal interactive interface instead of the full-screen TUI.

```bash
redsun mini
```

Run `redsun mini --help` to see its session, model, agent, prompt, and replay options.

## Background service

By default, redsun discovers or starts one shared background server for your user account. Every local redsun client
connects to that server, which owns sessions, configuration, integrations, permissions, and tool execution.

Use `--standalone` to run with a private server, or `--server` to connect to a specific server URL:

```bash
redsun --standalone
redsun --server http://localhost:4096
```

See [Troubleshooting](../troubleshooting.md) for shared service diagnostics and the [API reference](https://opencode.ai/v2/docs/api) for server endpoints.

## Paths

Print a specific local path for use with other tools:

```bash
redsun debug paths db
sqlite3 "$(redsun debug paths db)"
```

The optional selector accepts `db`, `home`, `data`, `config`, `cache`, `state`, `tmp`, `bin`, `log`, or `repos` and prints
only the path and a newline. The database path respects the release channel and `OPENCODE_DB`; relative database overrides
resolve under the data directory, and `:memory:` is printed as-is. This command does not start a server or open the database.

Omit the selector to show all paths with labels:

```bash
redsun debug paths
```

## Uninstall

Preview the files and installation that will be removed:

```bash
redsun uninstall --dry-run
```

Run `redsun uninstall` to confirm removal. redsun stops registered background services and persistent terminals before
removing global data, cache, configuration, and state. These directories are shared by redsun versions and channels.

To retain configuration and session data:

```bash
redsun uninstall --keep-config --keep-data
```

- `--keep-config` (`-c`) retains configuration files.
- `--keep-data` (`-d`) retains session data and snapshots. Cache and state are still removed.
- `--force` (`-f`) skips confirmation; use it for noninteractive removal.
- Package-manager installations use the detected package manager. Curl installations print the final command to remove
  the executable manually.
