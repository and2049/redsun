import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useVim } from "../../context/vim"
import { useDialog } from "../../ui/dialog"

// REDSUN: vim normal-mode keys over the transcript. j/k step between messages (J/K scroll by
// lines), g/G jump to the top or bottom, escape leaves message navigation. A count prefix
// repeats the motion; a borrowed normal mode (from insert) returns to insert afterwards.
export function useTranscriptVimKeys(input: {
  scroll: () => ScrollBoxRenderable | undefined
  navigating: () => boolean
  stopNavigating: () => void
  scrollLines: (lines: number) => void
  step: (direction: "next" | "prev") => void
  scrolled: () => void
}) {
  const vim = useVim()
  const dialog = useDialog()
  useKeyboard((event) => {
    if (vim.mode !== "normal") return
    if (event.ctrl || event.meta || event.option) return
    if (dialog.stack.length > 0 || vim.inputCaptured()) return
    const scroll = input.scroll()
    if (!scroll || scroll.isDestroyed) return

    const borrowed = vim.tempRemaining() !== null
    const release = () => {
      if (!borrowed) return
      vim.clearTemp()
      vim.setMode("insert")
    }

    if (event.name === "escape" && input.navigating()) {
      input.stopNavigating()
      return
    }
    if (event.name === "j" || event.name === "k") {
      event.preventDefault()
      const down = event.name === "j"
      const count = vim.takeCount()
      if (event.shift) input.scrollLines(down ? count : -count)
      else for (let step = 0; step < count; step++) input.step(down ? "next" : "prev")
      release()
      return
    }
    if (event.name === "g") {
      event.preventDefault()
      vim.clearCount()
      scroll.scrollTo(event.shift ? scroll.scrollHeight : 0)
      input.scrolled()
      release()
    }
  })
}
