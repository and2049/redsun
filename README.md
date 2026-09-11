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

Additional languages can be installed as ordinary TUI plugins and appear automatically
in `/language`. The bundled translations use the same plugin API. See the
[language-plugin author guide](packages/tui/src/i18n/README.md) for a minimal example,
translation templates, validation, fallback, and plural support.

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

## Pinned messages

Use **`/pin`** to pin or unpin the message selected by transcript navigation, or choose a
message from its picker. You can also click a user message or an assistant's **Message actions**.

**`/pins`** opens the current session's searchable pin list. Select a pin to read its full
message, including messages beyond the loaded scrollback. In the list, **Ctrl+R** renames a
pin and **Ctrl+D** removes it. Labels default to message text; leaving a custom label blank
restores that default. Labels can contain up to 200 characters.

In the reader, use **Up/Down** or **Page Up/Page Down** to scroll, **C** to copy, **R** to
rename, **D** to unpin, **Enter** to jump into the transcript, and **Escape** to return.
Reading a pin fetches it directly; jumping to an old message may load intervening history
pages. **Ctrl+End** cancels a history jump and returns to the latest message.

Pins and labels survive server restarts. They belong to one session: forks start without
pins, and deleting the original message or session removes its pins. Pins are bookmarks,
not instructions to retain content in the model's context, and are not included in session
exports. Optional keybindings are `session.pins` and `session.pin` in `cli.json`.

## Acknowledgements

Forked from [OpenCode](https://github.com/anomalyco/opencode/) under the MIT license.
