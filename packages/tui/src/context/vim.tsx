import { createSignal } from "solid-js"
import { createSimpleContext } from "./helper"
import type { VimMode } from "../vim"

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
