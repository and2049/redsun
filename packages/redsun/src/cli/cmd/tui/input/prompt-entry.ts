import type { ParsedKey } from "@opentui/core"

export type PromptEntryMode = "normal" | "shell"

export function shouldEnterShellEntry(evt: ParsedKey, cursorOffset: number) {
  return evt.name === "!" && cursorOffset === 0
}

export function shouldExitShellEntry(mode: PromptEntryMode, evt: ParsedKey, cursorOffset: number) {
  if (mode !== "shell") return false
  return (evt.name === "backspace" && cursorOffset === 0) || evt.name === "escape"
}

export function shouldUseAutocomplete(mode: PromptEntryMode) {
  return mode === "normal"
}
