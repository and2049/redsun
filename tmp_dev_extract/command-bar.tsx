import { createSignal, createEffect, Show, createMemo, For, Match, Switch } from "solid-js"
import { useMode, type VimMode } from "../context/mode"
import { useTheme, selectedForeground } from "../context/theme"
import { useCommandDialog } from "./dialog-command"
import type { InputRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "./border"
import { COMMAND_ALIASES, getCommandSuggestions, resolveCommandAlias } from "../input/command-mode"
import { getVimModeTransition } from "../input/mode"

const MAX_SUGGESTIONS = 10
const SUGGESTION_PADDING = 2
const SEPARATOR_WIDTH = 3

function ModeIndicator(props: { mode: VimMode }) {
  const { theme } = useTheme()
  return (
    <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
      {props.mode.toLowerCase()}
    </text>
  )
}

function CommandInput(props: {
  value: string
  onInput: (value: string) => void
  onRef: (ref: InputRenderable) => void
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" flexGrow={1}>
      <text fg={theme.primary}>:</text>
      <input
        ref={props.onRef}
        onInput={props.onInput}
        value={props.value}
        focusedBackgroundColor={theme.backgroundElement}
        cursorColor={theme.primary}
        focusedTextColor={theme.text}
        flexGrow={1}
      />
    </box>
  )
}

function CommandSuggestions(props: {
  suggestions: string[]
  selectedIndex: number
  width: number
}) {
  const { theme } = useTheme()
  return (
    <box
      position="absolute"
      bottom={1}
      left={0}
      width={props.width}
      flexDirection="column"
      backgroundColor={theme.backgroundMenu}
      {...SplitBorder}
      borderColor={theme.border}
      zIndex={100}
    >
      <For each={props.suggestions}>
        {(suggestion, index) => {
          const selected = () => index() === props.selectedIndex
          return (
            <box
              paddingLeft={1}
              paddingRight={1}
              flexDirection="row"
              backgroundColor={selected() ? theme.primary : undefined}
            >
              <text fg={selected() ? selectedForeground(theme) : theme.text} flexShrink={0}>
                {suggestion}
              </text>
              <text fg={selected() ? selectedForeground(theme) : theme.textMuted} wrapMode="none">
                {" "}- {COMMAND_ALIASES[suggestion]}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

export function CommandBar() {
  const vim = useMode()
  const { theme } = useTheme()
  const command = useCommandDialog()
  const dimensions = useTerminalDimensions()
  let inputRef: InputRenderable

  const [input, setInput] = createSignal("")
  const [lockedQuery, setLockedQuery] = createSignal<string | null>(null)
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  const suggestions = createMemo(() => {
    const val = lockedQuery() ?? input().trim().toLowerCase()
    return getCommandSuggestions(val, MAX_SUGGESTIONS)
  })

  const suggestionWidth = createMemo(() => {
    const list = suggestions()
    if (list.length === 0) return 0
    let max = 0
    for (const suggestion of list) {
      const alias = COMMAND_ALIASES[suggestion] ?? ""
      const width =
        SUGGESTION_PADDING +
        Bun.stringWidth(suggestion) +
        SEPARATOR_WIDTH +
        Bun.stringWidth(alias)
      if (width > max) max = width
    }
    return Math.min(max, dimensions().width)
  })

  createEffect(() => {
    if (vim.mode === "command" && inputRef) {
      inputRef.focus()
      setLockedQuery(null)
      setSelectedIndex(0)
    } else if (inputRef) {
      inputRef.blur()
    }
  })

  useKeyboard((evt) => {
    if (vim.mode !== "command") return

    const transition = getVimModeTransition("command", evt)
    if (transition?.reason === "execute-command") {
      const val = input().trim().toLowerCase()
      inputRef?.blur()
      vim.setMode(transition.mode)
      setInput("")
      if (transition.preventDefault) evt.preventDefault()

      setTimeout(() => {
        command.trigger(resolveCommandAlias(val))
      })
      return
    }

    if (transition?.reason === "exit-command") {
      vim.setMode(transition.mode)
      setInput("")
      if (transition.preventDefault) evt.preventDefault()
      return
    }

    if (evt.name === "tab") {
      evt.preventDefault()
      const list = suggestions()
      if (list.length === 0) return

      if (lockedQuery() === null) {
        setLockedQuery(input().trim().toLowerCase())
        setSelectedIndex(0)
        setInput(list[0])
      } else {
        const nextIndex = (selectedIndex() + (evt.shift ? -1 : 1) + list.length) % list.length
        setSelectedIndex(nextIndex)
        setInput(list[nextIndex])
      }
    }
  })

  const backgroundColor = createMemo(() =>
    vim.mode === "command" ? theme.backgroundElement : theme.background,
  )

  return (
    <box
      position="absolute"
      bottom={0}
      left={0}
      width={dimensions().width}
      height={1}
      zIndex={1000}
      backgroundColor={backgroundColor()}
      flexDirection="row"
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
    >
      <Switch>
        <Match when={vim.mode === "command"}>
          <CommandInput
            value={input()}
            onInput={(e) => {
              if (e === input()) return
              setLockedQuery(null)
              setSelectedIndex(0)
              setInput(e)
            }}
            onRef={(r) => {
              inputRef = r
            }}
          />
          <Show when={suggestions().length > 0}>
            <CommandSuggestions
              suggestions={suggestions()}
              selectedIndex={selectedIndex()}
              width={suggestionWidth()}
            />
          </Show>
        </Match>
        <Match when={true}>
          <ModeIndicator mode={vim.mode} />
        </Match>
      </Switch>
    </box>
  )
}
