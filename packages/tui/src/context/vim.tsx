import { createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { transition, type VimMode } from "../vim"
import { useOpencodeKeymap } from "../keymap"
import { useDialog } from "../ui/dialog"
import type { KeyEvent } from "@opentui/core"

const TEMP_DURATION_MS = 3000
const TICK_INTERVAL_MS = 250

type VimContext = {
  get mode(): VimMode
  setMode: (next: VimMode) => void
  requestMode: (next: VimMode) => void
  tempRemaining: () => number | null
  enterTempNormal: (ms?: number) => void
  clearTemp: () => void
}

export const { use: useVim, provider: VimProvider } = createSimpleContext({
  name: "Vim",
  init: () => {
    const [mode, setMode] = createSignal<VimMode>("insert")
    const [tempRemaining, setTempRemaining] = createSignal<number | null>(null)
    let tempEndAt = 0
    let tempTimer: ReturnType<typeof setTimeout> | null = null
    let tempTick: ReturnType<typeof setInterval> | null = null

    function clearTemp() {
      if (tempTimer) {
        clearTimeout(tempTimer)
        tempTimer = null
      }
      if (tempTick) {
        clearInterval(tempTick)
        tempTick = null
      }
      tempEndAt = 0
      setTempRemaining(null)
    }

    function enterTempNormal(ms: number = TEMP_DURATION_MS) {
      clearTemp()
      setMode("normal")
      tempEndAt = Date.now() + ms
      setTempRemaining(Math.ceil(ms / 1000))
      tempTick = setInterval(() => {
        const remain = Math.max(0, Math.ceil((tempEndAt - Date.now()) / 1000))
        if (remain !== tempRemaining()) setTempRemaining(remain)
      }, TICK_INTERVAL_MS)
      tempTimer = setTimeout(() => {
        clearTemp()
        setMode("insert")
      }, ms)
    }

    function requestMode(next: VimMode) {
      clearTemp()
      setMode(next)
    }

    return {
      get mode() {
        return mode()
      },
      setMode,
      requestMode,
      tempRemaining,
      enterTempNormal,
      clearTemp,
    } satisfies VimContext
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

  // ctrl+x is the configured leader, so the keymap's leader token matcher would
  // consume it (stopPropagation) before any appended useKeyboard listener runs.
  // Register a key intercept hook so we see ctrl+x before dispatchLayers arms
  // the leader, and route it to temp-normal instead.
  onMount(() => {
    const offIntercept = keymap.intercept(
      "key",
      (ctx: { event: KeyEvent; consume: () => void }) => {
        const event = ctx.event
        if (!event.ctrl || event.name !== "x" || vim.mode === "command") return
        ctx.consume()
        keymap.clearPendingSequence()
        vim.enterTempNormal()
      },
      { priority: 1000 },
    )
    onCleanup(offIntercept)
  })

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl || event.meta) return
    if (vim.mode === "command") return
    if (dialog.stack.length > 0 && event.name !== "escape") return
    if (vim.mode === "normal" && vim.tempRemaining() != null && event.name === "escape") {
      event.preventDefault()
      vim.clearTemp()
      vim.setMode("insert")
      return
    }
    const next = transition(vim.mode, event)
    if (next) {
      event.preventDefault()
      vim.requestMode(next)
      return
    }
    if (vim.mode !== "normal") return
    if (event.shift) return
    const command = NORMAL_LETTER_COMMANDS[event.name]
    if (!command) return
    if (dialog.stack.length > 0) return
    event.preventDefault()
    const wasTemp = vim.tempRemaining() != null
    keymap.dispatchCommand(command)
    if (wasTemp) {
      vim.clearTemp()
      vim.setMode("insert")
    }
  })

  return props.children as JSX.Element
}