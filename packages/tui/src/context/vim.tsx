import { createSignal, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { transition, type VimMode } from "../vim"
import { useOpencodeKeymap } from "../keymap"
import { useDialog } from "../ui/dialog"
import type { KeyEvent } from "@opentui/core"

export const { use: useVim, provider: VimProvider } = createSimpleContext({
  name: "Vim",
  init: () => {
    const [mode, setMode] = createSignal<VimMode>("insert")
    return {
      get mode() {
        return mode()
      },
      setMode,
    }
  },
})

// Bare-letter -> command name, available in normal mode. Bare letters in insert
// mode are typed into the prompt; in command mode the CommandBar owns input.
// Modifier chords and other keys are intentionally left to @opentui/keymap.
const NORMAL_LETTER_COMMANDS: Record<string, string> = {
  l: "session.list",
  s: "opencode.status",
  m: "model.list",
  a: "agent.list",
  t: "theme.switch",
  b: "session.sidebar.toggle",
  c: "session.compact",
  u: "session.undo",
  r: "session.redo",
  y: "messages.copy",
  e: "prompt.editor",
  x: "session.export",
  h: "session.toggle.conceal",
  q: "app.exit",
}

// VimKeyHandler mounts below DialogProvider so it can gate letter dispatch on
// the dialog stack. Mode transitions (Esc/i/:) run globally regardless of
// focus, mirroring dev's ModeProvider.useKeyboard.
export function VimKeyHandler(props: { children: JSX.Element }) {
  const vim = useVim()
  const keymap = useOpencodeKeymap()
  const dialog = useDialog()

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl || event.meta) return
    if (vim.mode === "command") return
    if (dialog.stack.length > 0 && event.name !== "escape") return
    const next = transition(vim.mode, event)
    if (next) {
      event.preventDefault()
      vim.setMode(next)
      return
    }
    if (vim.mode !== "normal") return
    if (event.shift) return
    const command = NORMAL_LETTER_COMMANDS[event.name]
    if (!command) return
    if (dialog.stack.length > 0) return
    event.preventDefault()
    keymap.dispatchCommand(command)
  })

  return props.children as JSX.Element
}