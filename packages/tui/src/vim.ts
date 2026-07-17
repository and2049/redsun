import type { KeyEvent } from "@opentui/core"

export type VimMode = "insert" | "normal" | "command"

export function transition(mode: VimMode, event: Pick<KeyEvent, "name" | "ctrl" | "meta">): VimMode | undefined {
  if (event.ctrl || event.meta) return
  if (mode === "insert" && event.name === "escape") return "normal"
  if (mode === "normal" && event.name === "i") return "insert"
  if (mode === "normal" && event.name === ":") return "command"
  if (mode === "command" && (event.name === "escape" || event.name === "return")) return "normal"
}
