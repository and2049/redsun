import type { ParsedKey } from "@opentui/core"
import { Keybind } from "@/util/keybind"

export function parseDialogSelectKey(evt: ParsedKey): Keybind.Info {
  if (evt.name === "\x1F") {
    return Keybind.fromParsedKey({ ...evt, name: "_", ctrl: true }, false)
  }
  return Keybind.fromParsedKey(evt, false)
}

export function matchDialogSelectKeybind(keybind: Keybind.Info, evt: ParsedKey) {
  return Keybind.match(keybind, parseDialogSelectKey(evt))
}
