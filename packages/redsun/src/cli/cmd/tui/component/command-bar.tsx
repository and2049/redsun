import { createSignal, createEffect, on, Show, onCleanup, batch } from "solid-js"
import { useMode } from "../context/mode"
import { useTheme } from "../context/theme"
import { useCommandDialog } from "./dialog-command"
import type { InputRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"

export function CommandBar() {
  const vim = useMode()
  const { theme } = useTheme()
  const command = useCommandDialog()
  let inputRef: InputRenderable

  const [input, setInput] = createSignal("")

  createEffect(() => {
    if (vim.mode === "command" && inputRef) {
      inputRef.focus()
    } else if (inputRef) {
      inputRef.blur()
    }
  })

  useKeyboard((evt) => {
    if (vim.mode !== "command") return

    if (evt.name === "return") {
      // Execute command
      const val = input()
      vim.setMode("normal")
      setInput("")
      evt.preventDefault()

      // Extremely basic routing for now
      setTimeout(() => {
        if (val === "theme") {
          command.trigger("theme.switch")
        } else if (val === "q" || val === "qa" || val === "qw" || val === "wq") {
          command.trigger("app.exit")
        } else {
          command.trigger(val)
        }
      })
    } else if (evt.name === "escape") {
      vim.setMode("normal")
      setInput("")
      evt.preventDefault()
    }
  })

  return (
    <box flexDirection="row" backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1} minHeight={1}>
      <Show when={vim.mode === "command"}>
        <text fg={theme.primary}>:</text>
        <input
          ref={(r) => {
            inputRef = r
            if (vim.mode === "command") {
              setTimeout(() => inputRef.focus(), 1)
            }
          }}
          onInput={(e) => setInput(e)}
          value={input()}
          focusedBackgroundColor={theme.backgroundElement}
          cursorColor={theme.primary}
          focusedTextColor={theme.text}
          flexGrow={1}
        />
      </Show>
    </box>
  )
}
