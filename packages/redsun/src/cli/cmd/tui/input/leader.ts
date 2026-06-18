import type { ParsedKey } from "@opentui/core"
import { Keybind } from "@/util/keybind"
import type { VimMode } from "./mode"

export type LeaderKeyAction = "enter-normal"

export function getLeaderKeyAction(mode: VimMode, leaderKeybinds: readonly Keybind.Info[] | undefined, evt: ParsedKey) {
  if (mode !== "insert") return
  const parsed = Keybind.fromParsedKey(evt, false)
  if (leaderKeybinds?.some((keybind) => Keybind.match(keybind, parsed))) return "enter-normal" satisfies LeaderKeyAction
}
