import type { ParsedKey } from "@opentui/core"
import type { VimMode } from "./mode"

export type SessionNavigationAction =
  | { type: "scroll-by"; amount: number }
  | { type: "scroll-top" }
  | { type: "scroll-bottom" }

export function getSessionNavigationAction(mode: VimMode, evt: ParsedKey): SessionNavigationAction | undefined {
  if (mode !== "normal") return
  if (evt.ctrl || evt.meta || evt.super) return

  if (evt.name === "j") return { type: "scroll-by", amount: 1 }
  if (evt.name === "k") return { type: "scroll-by", amount: -1 }
  if (evt.name === "g" && evt.shift) return { type: "scroll-bottom" }
  if (evt.name === "g" && !evt.shift) return { type: "scroll-top" }
}
