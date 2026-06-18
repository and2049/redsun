import type { ParsedKey } from "@opentui/core"
import type { VimMode } from "./mode"

export type ToolPermissionResponse = "once" | "always" | "reject"

export type TrustPermissionResponse = {
  trusted: boolean
  remember: boolean
}

export function getToolPermissionResponse(mode: VimMode, evt: ParsedKey): ToolPermissionResponse | undefined {
  if (evt.ctrl || evt.meta) return
  if (mode !== "normal") return
  if (evt.name === "return") return "once"
  if (evt.name === "y") return "always"
  if (evt.name === "n") return "reject"
  if (evt.name === "escape") return "reject"
}

export function getTrustPermissionResponse(mode: VimMode, evt: ParsedKey): TrustPermissionResponse | undefined {
  if (evt.ctrl || evt.meta) return
  if (mode !== "normal") return
  if (evt.name === "return") return { trusted: true, remember: true }
  if (evt.name === "y") return { trusted: true, remember: true }
  if (evt.name === "t") return { trusted: true, remember: false }
  if (evt.name === "n") return { trusted: false, remember: false }
  if (evt.name === "escape") return { trusted: false, remember: false }
}
