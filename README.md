# redsun

An extensible, multi-agent coding harness.

## Agent Modes

redsun has three primary agent modes:

- **Build** — The default implementation agent with the full tool set: read, write, edit, shell commands, and more. Use for direct coding and file manipulation.
- **Plan** — Read-only analysis and planning mode. Disallows file edits and shell execution, with write access limited to `.redsun/plans/` for saving plans.
- **Compose** — A coordinator that plans, investigates, and delegates scoped implementation work to worker subagents. Compose has read, search, web, and skill access but cannot directly edit files or run commands.

## Install

**Linux / macOS / WSL:**

```bash
curl -fsSL https://github.com/and2049/redsun/releases/latest/download/install | bash
```

**Windows (PowerShell):**

```powershell
irm https://github.com/and2049/redsun/releases/latest/download/install.ps1 | iex
```

## Acknowledgements

Forked from [OpenCode](https://github.com/anthropics/opencode) under the MIT license.
