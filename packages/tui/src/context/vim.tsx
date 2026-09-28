import { createEffect, createSignal, onCleanup, onMount, useContext, type Accessor, type JSX } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { KeyEvent } from "@opentui/core"
import { createSimpleContext } from "./helper"
import { Keymap } from "./keymap"
import { useDialog } from "../ui/dialog"
import { NORMAL_LETTER_COMMANDS, pushCount, transition, type VimMode } from "../vim"

const TEMP_DURATION_MS = 3000
const TICK_INTERVAL_MS = 250

export const {
  use: useVim,
  provider: VimProvider,
  context: VimContext,
} = createSimpleContext({
  name: "Vim",
  init: () => {
    const [mode, setMode] = createSignal<VimMode>("insert")
    const [tempRemaining, setTempRemaining] = createSignal<number | null>(null)
    const [pendingCount, setPendingCount] = createSignal<number | null>(null)
    const [captures, setCaptures] = createSignal(0)
    let tempEndAt = 0
    let tempTimer: ReturnType<typeof setTimeout> | undefined
    let tempTick: ReturnType<typeof setInterval> | undefined

    function clearCount() {
      setPendingCount(null)
    }

    function takeCount() {
      const count = pendingCount() ?? 1
      setPendingCount(null)
      return count
    }

    function clearTemp() {
      if (tempTimer) clearTimeout(tempTimer)
      if (tempTick) clearInterval(tempTick)
      tempTimer = undefined
      tempTick = undefined
      tempEndAt = 0
      setTempRemaining(null)
    }

    function enterTempNormal(ms: number = TEMP_DURATION_MS) {
      clearTemp()
      clearCount()
      setMode("normal")
      tempEndAt = Date.now() + ms
      setTempRemaining(Math.ceil(ms / 1000))
      tempTick = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((tempEndAt - Date.now()) / 1000))
        if (remaining !== tempRemaining()) setTempRemaining(remaining)
      }, TICK_INTERVAL_MS)
      tempTimer = setTimeout(() => {
        clearTemp()
        clearCount()
        setMode("insert")
      }, ms)
    }

    function requestMode(next: VimMode) {
      clearTemp()
      clearCount()
      setMode(next)
    }

    function captureInput() {
      setCaptures((count) => count + 1)
      return () => setCaptures((count) => count - 1)
    }

    onCleanup(clearTemp)

    return {
      get mode() {
        return mode()
      },
      setMode,
      requestMode,
      tempRemaining,
      enterTempNormal,
      clearTemp,
      pendingCount,
      pushCountDigit: (digit: number) => setPendingCount((current) => pushCount(current, digit)),
      takeCount,
      clearCount,
      inputCaptured: () => captures() > 0,
      captureInput,
    }
  },
})

export function useVimInputCapture(enabled: Accessor<boolean>) {
  const vim = useContext(VimContext)
  createEffect(() => {
    if (vim && enabled()) onCleanup(vim.captureInput())
  })
}

export function VimKeyHandler(props: { children: JSX.Element }) {
  const vim = useVim()
  const keymap = Keymap.use()
  const dialog = useDialog()

  onMount(() => {
    onCleanup(
      keymap.intercept(
        "key",
        (ctx) => {
          const event = ctx.event
          if (!event.ctrl || event.name !== "x" || vim.mode === "command" || vim.inputCaptured()) return
          ctx.consume()
          keymap.clearPendingSequence()
          vim.enterTempNormal()
        },
        { priority: 1000 },
      ),
    )
  })

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl || event.meta) return
    if (vim.mode === "command" || vim.inputCaptured()) return
    if (dialog.stack.length > 0 && event.name !== "escape") return

    if (vim.mode === "normal" && vim.tempRemaining() !== null && event.name === "escape") {
      event.preventDefault()
      vim.clearTemp()
      vim.clearCount()
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

    if (/^[0-9]$/.test(event.name)) {
      if (event.option || event.shift) return
      if (event.name === "0" && vim.pendingCount() === null) return
      event.preventDefault()
      vim.pushCountDigit(Number(event.name))
      return
    }
    if (event.name === "escape" && vim.pendingCount() !== null) {
      event.preventDefault()
      vim.clearCount()
      return
    }
    if (event.shift) return

    const command = NORMAL_LETTER_COMMANDS[event.name]
    if (!command || dialog.stack.length > 0) return
    event.preventDefault()
    const borrowed = vim.tempRemaining() !== null
    keymap.dispatch(command)
    vim.clearCount()
    if (!borrowed) return
    vim.clearTemp()
    vim.setMode("insert")
  })

  return props.children as JSX.Element
}
