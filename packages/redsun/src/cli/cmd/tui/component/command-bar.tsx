import { createSignal, createEffect, Show, createMemo, For, Match, Switch } from "solid-js"
import { useMode, type VimMode } from "../context/mode"
import { useTheme, selectedForeground } from "../context/theme"
import { useCommandDialog } from "./dialog-command"
import type { InputRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import fuzzysort from "fuzzysort"
import { SplitBorder } from "./border"

const COMMAND_ALIASES: Record<string, string> = {
  // Session
  ls: "session.list",
  session: "session.list",
  sessions: "session.list",
  new: "session.new",
  enew: "session.new",
  rename: "session.rename",
  timeline: "session.timeline",
  tl: "session.timeline",
  fork: "session.fork",
  compact: "session.compact",
  unshare: "session.unshare",
  undo: "session.undo",
  u: "session.undo",
  redo: "session.redo",
  sidebar: "session.sidebar.toggle",
  interrupt: "session.interrupt",
  stop: "session.interrupt",

  // Agent / Model
  model: "model.list",
  models: "model.list",
  mcycle: "model.cycle_recent",
  mcyclerev: "model.cycle_recent_reverse",
  mfav: "model.cycle_favorite",
  mfavrev: "model.cycle_favorite_reverse",
  agent: "agent.list",
  agents: "agent.toggle",
  acycle: "agent.cycle",
  acyclerev: "agent.cycle.reverse",
  mcp: "mcp.list",
  mcps: "mcp.list",
  provider: "provider.connect",
  providers: "provider.connect",

  // Prompt
  clear: "prompt.clear",
  submit: "prompt.submit",
  paste: "prompt.paste",
  stash: "prompt.stash",
  pop: "prompt.stash.pop",
  stashes: "prompt.stash.list",

  // System
  theme: "theme.switch",
  themes: "theme.switch",
  mode: "theme.switch_mode",
  appearance: "theme.switch_mode",
  status: "opencode.status",
  help: "help.show",
  h: "help.show",
  q: "app.exit",
  qa: "app.exit",
  qw: "app.exit",
  wq: "app.exit",
  exit: "app.exit",
  quit: "app.exit",
  debug: "app.debug",
  console: "app.console",
  suspend: "terminal.suspend",
  tips: "tips.toggle",
}

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
    if (!val) return []
    const aliases = Object.keys(COMMAND_ALIASES)
    return fuzzysort
      .go(val, aliases)
      .map((res) => res.target)
      .slice(0, MAX_SUGGESTIONS)
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

    if (evt.name === "return") {
      const val = input().trim().toLowerCase()
      inputRef?.blur()
      vim.setMode("normal")
      setInput("")
      evt.preventDefault()

      setTimeout(() => {
        const target = COMMAND_ALIASES[val]
        if (target) {
          command.trigger(target)
        } else {
          command.trigger(val)
        }
      })
      return
    }

    if (evt.name === "escape") {
      vim.setMode("normal")
      setInput("")
      evt.preventDefault()
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
