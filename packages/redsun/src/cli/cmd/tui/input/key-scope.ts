import type { ParsedKey } from "@opentui/core"
import { Keybind } from "@/util/keybind"
import type { VimMode } from "./mode"

export type KeyScope = "global" | "dialog" | "prompt" | "raw"

export type KeyScopeContext = {
  leader: boolean
  vimMode: VimMode
}

// Some control chords (ctrl+_, ctrl+\) are delivered by the terminal as raw
// control bytes rather than as { ctrl: true } events. Normalize them to the
// modifier-chord form so they match config keybinds like "ctrl+\" / "ctrl+_".
function effectiveKey(evt: ParsedKey): ParsedKey {
  if (evt.name === "\x1F") return { ...evt, name: "_", ctrl: true }
  if (evt.name === "\x1C") return { ...evt, name: "\\", ctrl: true }
  return evt
}

function leaderForScope(scope: KeyScope, context: KeyScopeContext, evt: ParsedKey) {
  // Modifier-chord shortcuts (ctrl/meta/super) are unambiguous application
  // shortcuts and never collide with vim bare-letter motions, so they are
  // exempt from the normal-mode leader-forcing. Bare letters in normal mode
  // still require a <leader> prefix to avoid swallowing vim motions.
  const hasModifier = evt.ctrl || evt.meta || evt.super
  switch (scope) {
    case "global":
      return context.leader || (context.vimMode === "normal" && !hasModifier)
    case "prompt":
    case "dialog":
      return context.leader
    case "raw":
      return false
  }
}

export function parseScopedKey(evt: ParsedKey, scope: KeyScope, context: KeyScopeContext): Keybind.Info {
  const normalized = effectiveKey(evt)
  const leader = leaderForScope(scope, context, normalized)
  return Keybind.fromParsedKey(normalized, leader)
}

export function matchScopedKeybind(keybind: Keybind.Info, evt: ParsedKey, scope: KeyScope, context: KeyScopeContext) {
  return Keybind.match(keybind, parseScopedKey(evt, scope, context))
}
