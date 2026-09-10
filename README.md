## Install

**Linux / macOS / WSL:**

```bash
curl -fsSL https://github.com/and2049/redsun/releases/latest/download/install | bash
```

**Windows (PowerShell):**

```powershell
irm https://github.com/and2049/redsun/releases/latest/download/install.ps1 | iex
```

## Context settings

In **Settings → Context**, configure global backend defaults:

- **Stale-read deduplication** is off by default to preserve prompt-cache reuse. Enabling it
  shortens superseded read results, which can break cached conversation prefixes and increase costs.
- **Compaction mode** defaults to **LLM**, using OpenCode v2's model-based summary behavior.
  **Hybrid** adds a structured inventory; **Algorithmic** creates an inventory without a model call.

Changes are saved in the server's global `redsun.json` or `redsun.jsonc`. Project configuration
can override them. The corresponding configuration is:

```json
{
  "stale_read_deduplication": false,
  "compaction": { "strategy": "llm" }
}
```

## Acknowledgements

Forked from [OpenCode](https://github.com/anomalyco/opencode/) under the MIT license.
