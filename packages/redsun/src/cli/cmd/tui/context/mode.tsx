import { createSimpleContext } from "./helper"
import { createSignal } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { getVimModeTransition, type VimMode } from "../input/mode"

export type { VimMode }

export const { use: useMode, provider: ModeProvider } = createSimpleContext({
  name: "Mode",
  init: () => {
    const [mode, setMode] = createSignal<VimMode>("insert")

    useKeyboard((evt) => {
      const transition = getVimModeTransition(mode(), evt)
      if (!transition) return
      if (transition.reason !== "enter-insert" && transition.reason !== "enter-command") return
      setMode(transition.mode)
      if (transition.preventDefault) evt.preventDefault()
    })

    return {
      get mode() {
        return mode()
      },
      setMode,
    }
  },
})
