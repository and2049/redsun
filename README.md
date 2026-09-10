## Install

**Linux / macOS / WSL:**

```bash
curl -fsSL https://github.com/and2049/redsun/releases/latest/download/install | bash
```

**Windows (PowerShell):**

```powershell
irm https://github.com/and2049/redsun/releases/latest/download/install.ps1 | iex
```

## Interface language

Open **Settings → Appearance → Interface language**, or run **`/language`**, to choose
English, 简体中文 (Simplified Chinese), Español (Spanish), 한국어 (Korean), or Français (French).
The interface updates immediately and remembers your choice in the global `cli.json`.
The picker supports native language names, English names, and locale codes.

English is the default and the fallback for untranslated text. This preference controls
interface labels; conversation content remains in its original language.

```json
{ "language": "zh-CN" }
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
