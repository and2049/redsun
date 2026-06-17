import { createSimpleContext } from "./helper"
import { createSignal } from "solid-js"
import { useKeyboard } from "@opentui/solid"

export type VimMode = "normal" | "insert" | "command"

export const { use: useMode, provider: ModeProvider } = createSimpleContext({
  name: "Mode",
  init: () => {
    const [mode, setMode] = createSignal<VimMode>("insert")

    useKeyboard((evt) => {
      // Don't intercept if there are any modifiers except shift
      if (evt.ctrl || evt.meta || evt.super) return

      const current = mode()
      if (current === "normal") {
        if (evt.name === "i") {
          setMode("insert")
          evt.preventDefault()
        } else if (evt.name === ":") {
          setMode("command")
          evt.preventDefault()
        }
      }
    })

    return {
      get mode() {
        return mode()
      },
      setMode,
    }
  },
})
