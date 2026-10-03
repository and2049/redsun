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

Open **Settings → Appearance → Interface language**, or run **`/language`**
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
message from its picker. Right-click any message for its actions (jump, pin, copy, revert,
fork); left-clicking a user message opens the same menu.

Press **Escape** to leave the prompt, then **J**/**K** step through messages (the selected
one is tinted, with an accent bar in the margin for assistant replies), **Shift+J**/**Shift+K**
scroll by line, **F** pins the
selected message, **Escape** clears the selection and **I** returns to the prompt.

**`/pins`** opens the current session's searchable pin list. Select a pin to read its full
message, including messages beyond the loaded scrollback. In the list, **Ctrl+R** renames a
pin and **Ctrl+D** removes it. Labels default to message text; leaving a custom label blank
restores that default. Labels can contain up to 200 characters.

In the reader, use **Up/Down** or **Page Up/Page Down** to scroll, **C** to copy, **R** to
rename, **D** to unpin, **Enter** to jump into the transcript, and **Escape** to return.
Reading a pin fetches it directly; jumping to an old message may load intervening history
pages. **Ctrl+End** cancels a history jump and returns to the latest message.

## Claude Code behavior

The delegated `claude-code` provider uses your installed `claude` executable through the official
Agent SDK. Claude Code owns its native agent loop, conversation history and compaction; redsun
provides the surrounding session interface and host integrations.

`claude_code.behavior` defaults to `"redsun"`. This adds a short Claude Code-specific workflow
extension to its native system prompt and delivers redsun agent instructions and discovered project
context. Claude Code retains its native identity. Claude models used through ordinary API providers
continue using the normal redsun harness prompt.

To select the native behavior profile explicitly:

```json
{
  "claude_code": { "behavior": "native" }
}
```

Use a fresh session after changing profiles for a clean comparison: a resumed Claude transcript can
retain previously delivered instructions. The native profile still uses redsun's existing question,
permission and worker integration. Authentication remains owned by the installed CLI; behavior
selection does not select or guarantee a billing category.

Explicit host permission denials are checked before native tool execution, including under Claude
Code's auto-approval modes. Native tools otherwise retain Claude Code's approval flow: a host `ask`
rule does not force an extra prompt for a call the native runtime already approves. Host tools exposed
through MCP retain their own redsun permission checks.

In the redsun profile, connected MCP tools are available through the host bridge: direct tools stay
direct, and Code Mode tools use redsun's `execute` tool and catalog discovery. These calls reuse
redsun's connections and authentication. MCP resources, prompts and server instructions are not
forwarded by this bridge.

The permission toggle adds **Approve for me** when the selected main model is `claude-code`:
manual approvals → Approve for me → Auto-approve all. Approve for me selects Claude Code's native
automatic permission classifier; fallback approvals and host MCP permission requests can still
appear. Auto-approve all deterministically approves host `ask` decisions while retaining explicit
denials. Other main providers keep the two-state toggle and treat a stored Approve for me selection
as manual approval. The selection is location-wide; plan mode and worker-specific native permission
settings retain their separate behavior.

## Acknowledgements

Forked from [OpenCode](https://github.com/anomalyco/opencode/) under the MIT license.
