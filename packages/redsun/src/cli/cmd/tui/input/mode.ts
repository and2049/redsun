import type { ParsedKey } from "@opentui/core"

export type VimMode = "insert" | "normal" | "command"

export type ModeTransitionReason =
  | "enter-insert"
  | "enter-command"
  | "exit-insert"
  | "exit-command"
  | "execute-command"

export type ModeTransition = {
  mode: VimMode
  preventDefault: boolean
  reason: ModeTransitionReason
}

export type ModeTransitionContext = {
  subagentReadOnly?: boolean
}

export function getVimModeTransition(current: VimMode, evt: ParsedKey): ModeTransition | undefined {
  if (evt.ctrl || evt.meta || evt.super) return

  if (current === "normal") {
    if (evt.name === "i") {
      return { mode: "insert", preventDefault: true, reason: "enter-insert" }
    }
    if (evt.name === ":") {
      return { mode: "command", preventDefault: true, reason: "enter-command" }
    }
  }

  if (current === "insert" && evt.name === "escape") {
    return { mode: "normal", preventDefault: true, reason: "exit-insert" }
  }

  if (current === "command") {
    if (evt.name === "escape") {
      return { mode: "normal", preventDefault: true, reason: "exit-command" }
    }
    if (evt.name === "return") {
      return { mode: "normal", preventDefault: true, reason: "execute-command" }
    }
  }
}

export function isVimModeTransitionAllowed(transition: ModeTransition, context: ModeTransitionContext) {
  if (context.subagentReadOnly && transition.reason === "enter-insert") return false
  return true
}

export function modeForContext(mode: VimMode, context: ModeTransitionContext): VimMode {
  if (context.subagentReadOnly && mode === "insert") return "normal"
  return mode
}
