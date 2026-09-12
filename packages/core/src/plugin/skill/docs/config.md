# Config

Create `redsun.jsonc` in your project to configure OpenCode. Add the schema for editor validation, then set only the options you need.

```jsonc title="redsun.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
}
```

You can also ask redsun to update this file for you.

## Format

redsun supports JSON and JSONC. Use JSONC when you want comments or trailing commas.

```jsonc title="redsun.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  // Use this model by default.
  "model": "anthropic/claude-sonnet-4-5",
}
```

## Locations

Put settings for every project in the global configuration:

```text
~/.config/redsun/redsun.json(c)
```

Put project settings in either of these files:

```text
/home/user/projects/my-app/redsun.json(c)
/home/user/projects/my-app/.redsun/redsun.json(c)
```

redsun searches from the current directory to the filesystem root. It first
merges direct `redsun.json(c)` files from the farthest directory to the
closest, then merges files inside `.redsun` directories in the same order.
This means every discovered `.redsun` config overrides every direct config.
Use one form throughout a directory tree unless you need that behavior.

For example, start redsun from `/home/user/projects/acme/packages/web`:

```text
~/.config/redsun/redsun.json

/home/user/projects/acme/
├── redsun.json
└── packages/
    └── web/
        ├── redsun.json
        └── src/
```

redsun applies these files from lowest to highest precedence:

1. `~/.config/redsun/redsun.json`
2. `/home/user/projects/acme/redsun.json`
3. `/home/user/projects/acme/packages/web/redsun.json`

The package config overrides matching settings from the repository config,
which overrides the global config. Settings that do not conflict are preserved.

## Schema

The complete redsun configuration schema is available at
[opencode.ai/config.json](https://opencode.ai/config.json).

Add the `$schema` field to your configuration file to enable validation and
autocomplete in editors that support JSON Schema:

```json title="redsun.json"
{
  "$schema": "https://opencode.ai/config.json"
}
```

Use the schema as the source of truth for available fields, accepted values,
and nested configuration shapes.

### Shell

Set the shell used by the terminal and shell tools.

```jsonc
{
  "shell": "/bin/zsh",
}
```

### Model

Set the default model in `provider/model` format. The root default currently
does not retain a `#variant`; agent and command model references can select one.

```jsonc
{
  "model": "anthropic/claude-sonnet-4-5",
}
```

See the [models guide](models.md) for model selection and local models.

### Agent

Choose the primary agent used when a session does not select one explicitly.

```jsonc
{
  "default_agent": "build",
}
```

See the [agents guide](agents.md) for built-in and custom
agents.

### Updates

Control update checks from the global config. Set `update` to `"disable"` to
skip them, `"notify"` to show available updates before installing them, or
`"auto"` to install updates automatically. When omitted, `update` defaults to `"auto"`.

Automatic installation does not restart a running server. Restart it manually to activate the installed update.
Project-level values are ignored.

```jsonc
{
  "update": "notify",
}
```

### Sharing

Set the session sharing policy. redsun accepts this field, but session sharing
is not supported yet.

```jsonc
{
  "share": "manual",
}
```

See the [sharing guide](sharing.md) for more details.

### Username

Set a username. redsun accepts this field but does not display it in
conversations.

```jsonc
{
  "username": "alice",
}
```

### Permissions

Define ordered rules that allow, deny, or ask before an agent uses a tool on a
matching resource.

```jsonc
{
  "permissions": [
    {
      "action": "shell",
      "resource": "git push *",
      "effect": "ask",
    },
  ],
}
```

See the [permissions guide](permissions.md) for rule matching and available actions.

### Agents

Override built-in agents or define specialized agents with their own model,
instructions, mode, and permissions.

```jsonc
{
  "agents": {
    "reviewer": {
      "description": "Review changes without editing files",
      "mode": "subagent",
      "system": "Focus on correctness, security, and missing tests.",
      "permissions": [{ "action": "edit", "resource": "*", "effect": "deny" }],
    },
  },
}
```

See the [agents guide](agents.md) for all agent options and file-based agents.

### Snapshots

Enable or disable filesystem snapshots used by undo and revert behavior.

```jsonc
{
  "snapshots": false,
}
```

See the [snapshots guide](snapshots.md) for undo and redo behavior.

### Watcher

Ignore files and directories that should not trigger filesystem updates.

```jsonc
{
  "watcher": {
    "ignore": ["dist/**", "coverage/**"],
  },
}
```

### Formatter

Format files after the `write`, `edit`, or `patch` tools change them. Set
`formatter` to `true` to enable available built-in formatters.

```jsonc
{
  "formatter": true,
}
```

See the [formatters guide](formatters.md) for built-ins and custom formatters.

### Media

Control how oversized images loaded by the `read` tool are resized or rejected
before they are sent to a model.

```jsonc
{
  "media": {
    "image": {
      "auto_resize": true,
      "max_width": 2000,
      "max_height": 2000,
      "max_base64_bytes": 5242880,
    },
  },
}
```

See the [attachments guide](attachments.md) for image processing and limits.

### Output

Set the maximum number of lines and bytes retained from a tool result.

```jsonc
{
  "tool_output": {
    "max_lines": 2000,
    "max_bytes": 51200,
  },
}
```

### Search

Choose how redsun searches the web. Use `"random"` to select an available
provider automatically.

```jsonc
{
  "websearch": {
    "provider": "random",
  },
}
```

See the [websearch guide](websearch.md) for providers, credentials, selection,
rate limits, and disabling search.

### MCP

Configure local and remote Model Context Protocol servers. Global timeouts can
be overridden by an individual server.

```jsonc
{
  "mcp": {
    "servers": {
      "playwright": {
        "type": "local",
        "command": ["bunx", "@playwright/mcp"],
      },
    },
  },
}
```

See the [MCP guide](mcp-servers.md) for remote servers, OAuth, environment variables, and timeouts.

### Compaction

Control automatic context compaction and how much recent context it preserves.

```jsonc
{
  "compaction": {
    "auto": true,
    "keep": {
      "tokens": 15000,
    },
    "buffer": 20000,
  },
}
```

Local summaries remain the default. Opt into native provider compaction for both
automatic and manual requests with a provider or model policy:

```jsonc
{
  "providers": {
    "openai": {
      "compaction": { "mode": "provider", "threshold": 120000 },
      "models": {
        "gpt-4.1": { "compaction": { "mode": "local" } },
      },
    },
  },
}
```

A model policy replaces the whole provider policy. The optional positive integer
`threshold` defaults to the selected model's usable input budget and cannot exceed
its safe ceiling. Provider checkpoints keep recent user messages within the same
`compaction.tokens` budget that local summaries use for their retained tail.
Top-level `compaction.auto: false` disables new automatic compaction without
discarding installed checkpoints. See the [compaction guide](compaction.md) for
budgeting and overflow recovery.

### Warming

Keep recently active model sessions warm with periodic transient requests.
Warming is disabled by default; set it to `true` to use the four-minute idle
interval and 30-minute active window.

```jsonc
{
  "warming": {
    "prompt": "Do not perform any work. Reply with exactly: OK",
    "interval": "4 minutes",
    "duration": "30 minutes",
  },
}
```

See the [warming guide](warming.md) for request behavior, customization,
and cost considerations.

### Skills

Add directories or URLs that redsun should search for agent skills.

```jsonc
{
  "skills": ["./team-skills", "https://example.com/.well-known/skills/"],
}
```

See the [skills guide](skills.md) for skill structure and automatic discovery under `.redsun/skills/`.

### Commands

Define reusable slash commands as named prompt templates.

```jsonc
{
  "commands": {
    "review": {
      "description": "Review the current changes",
      "template": "Review the current diff for correctness and missing tests.",
    },
  },
}
```

See the [commands guide](commands.md) for arguments, models, agents, and file-based commands.

### Instructions

Declare additional instruction files, globs, or URLs. redsun accepts this
field but does not load its entries; use `AGENTS.md` for instructions.

```jsonc
{
  "instructions": ["CONTRIBUTING.md", "docs/guidelines/*.md"],
}
```

See the [instructions guide](instructions.md) for project instructions and `AGENTS.md`.

### References

Make local directories or Git repositories available as named supporting
context.

```jsonc
{
  "references": {
    "docs": {
      "path": "../product-docs",
      "description": "Product behavior and terminology",
    },
    "effect": {
      "repository": "Effect-TS/effect",
      "branch": "main",
    },
  },
}
```

See the [references guide](references.md) for shorthand, visibility, and path resolution.

### Worktrees

Set the parent directory for new local worktrees. redsun appends the requested or generated worktree name.

```jsonc
{
  "worktree": {
    "directory": "../worktrees",
  },
}
```

Relative paths resolve against the project's primary checkout, including when called from a subdirectory or linked
worktree. This applies to global and project configuration alike; absolute paths are used as-is, and `~/` resolves
against the user's home directory.

For example, this global configuration places new worktrees under each project's own `.lane/trees/` directory:

```jsonc
{
  "worktree": {
    "directory": ".lane/trees",
  },
}
```

Without this setting, creation uses the server's data directory under `worktree/<first-six-project-ID-characters>`.
Configuration applies to the caller's location, not every clone sharing a project ID. Changing it does not move existing worktrees.

Git is the built-in default. A [plugin](build/plugins/index.md#worktrees) that registers a strategy automatically becomes the
default for its location. Strategy-specific options belong to that plugin, not the `worktree` config object.

### Plugins

Load plugins from packages or local plugin directories. Use the object form when a plugin
accepts options.

```jsonc
{
  "plugins": [
    "opencode-example-plugin",
    {
      "package": "./plugins/local",
      "options": {
        "enabled": true,
      },
    },
  ],
}
```

See the [plugins guide](plugins.md) for plugin loading and configuration.

### Providers

Configure providers and add or override their models, request settings,
headers, and model variants.

```jsonc
{
  "providers": {
    "openai": {
      "models": {
        "gpt-5.2-custom": {
          "modelID": "gpt-5.2",
          "name": "GPT-5.2 Custom",
          "limit": {
            "context": 200000,
            "output": 32000,
          },
        },
      },
    },
  },
}
```

`websocket: true` on a provider or model opts into its supported session
WebSocket; a model policy overrides the provider policy.

See the [providers guide](providers.md) for credentials, custom endpoints, provider packages, the WebSocket transport, and model configuration.
