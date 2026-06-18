import type { ParsedKey } from "@opentui/core"
import { Keybind } from "@/util/keybind"
import type { VimMode } from "./mode"

export type KeyScope = "global" | "dialog" | "prompt" | "raw"

export type KeyScopeContext = {
  leader: boolean
  vimMode: VimMode
}

function leaderForScope(scope: KeyScope, context: KeyScopeContext) {
  switch (scope) {
    case "global":
      return context.leader || context.vimMode === "normal"
    case "prompt":
    case "dialog":
      return context.leader
    case "raw":
      return false
  }
}

export function parseScopedKey(evt: ParsedKey, scope: KeyScope, context: KeyScopeContext): Keybind.Info {
  const leader = leaderForScope(scope, context)
  if (evt.name === "\x1F") {
    return Keybind.fromParsedKey({ ...evt, name: "_", ctrl: true }, leader)
  }
  return Keybind.fromParsedKey(evt, leader)
}

export function matchScopedKeybind(keybind: Keybind.Info, evt: ParsedKey, scope: KeyScope, context: KeyScopeContext) {
  return Keybind.match(keybind, parseScopedKey(evt, scope, context))
}
