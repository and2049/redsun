import { createSimpleContext } from "./helper"
import { createSignal, onCleanup } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { getVimModeTransition, isVimModeTransitionAllowed, type ModeTransitionContext, type VimMode } from "../input/mode"

export type { VimMode }

export const { use: useMode, provider: ModeProvider } = createSimpleContext({
  name: "Mode",
  init: () => {
    const [mode, setMode] = createSignal<VimMode>("insert")
    const [guards, setGuards] = createSignal<(() => ModeTransitionContext)[]>([])

    useKeyboard((evt) => {
      const transition = getVimModeTransition(mode(), evt)
      if (!transition) return
      if (transition.reason !== "enter-insert" && transition.reason !== "enter-command") return
      const context = guards().reduce((acc, guard) => ({ ...acc, ...guard() }), {} as ModeTransitionContext)
      if (!isVimModeTransitionAllowed(transition, context)) {
        if (transition.preventDefault) evt.preventDefault()
        return
      }
      setMode(transition.mode)
      if (transition.preventDefault) evt.preventDefault()
    })

    return {
      get mode() {
        return mode()
      },
      setMode,
      guard(cb: () => ModeTransitionContext) {
        setGuards((current) => [...current, cb])
        onCleanup(() => {
          setGuards((current) => current.filter((item) => item !== cb))
        })
      },
    }
  },
})
