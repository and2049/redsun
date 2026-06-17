import { createSignal, createEffect, on, Show, onCleanup, batch, createMemo, For } from "solid-js"
import { useMode } from "../context/mode"
import { useTheme } from "../context/theme"
import { useCommandDialog } from "./dialog-command"
import type { InputRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
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
  agents: "agent.list",
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

export function CommandBar() {
  const vim = useMode()
  const { theme } = useTheme()
  const command = useCommandDialog()
  let inputRef: InputRenderable

  const [input, setInput] = createSignal("")
  const [lockedQuery, setLockedQuery] = createSignal<string | null>(null)
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  const suggestions = createMemo(() => {
    const val = lockedQuery() ?? input().trim().toLowerCase()
    if (!val) return []
    const aliases = Object.keys(COMMAND_ALIASES)
    return fuzzysort.go(val, aliases).map((res) => res.target).slice(0, 10)
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
      // Execute command
      const val = input().trim().toLowerCase()
      inputRef?.blur() // explicitly blur before executing, prevents segfaults on exit
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
    } else if (evt.name === "escape") {
      vim.setMode("normal")
      setInput("")
      evt.preventDefault()
    } else if (evt.name === "tab") {
      evt.preventDefault()
      const list = suggestions()
      if (list.length > 0) {
        if (lockedQuery() === null) setLockedQuery(input().trim().toLowerCase())
        const nextIndex = (selectedIndex() + (evt.shift ? -1 : 1) + list.length) % list.length
        setSelectedIndex(nextIndex)
        setInput(list[nextIndex])
      }
    }
  })

  return (
    <box flexDirection="row" backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1} minHeight={1}>
      <Show when={vim.mode === "command"}>
        <Show when={suggestions().length > 0}>
          <box 
            position="absolute" 
            bottom={1} 
            left={0} 
            flexDirection="column" 
            backgroundColor={theme.backgroundMenu} 
            {...SplitBorder}
            borderColor={theme.border}
          >
            <For each={suggestions()}>
              {(suggestion, index) => (
                <box 
                  paddingLeft={1} 
                  paddingRight={1} 
                  flexDirection="row"
                  backgroundColor={index() === selectedIndex() ? theme.primary : undefined}
                >
                  <text fg={index() === selectedIndex() ? theme.background : theme.text}>
                    {suggestion}
                  </text>
                  <text fg={theme.textMuted}> - {COMMAND_ALIASES[suggestion]}</text>
                </box>
              )}
            </For>
          </box>
        </Show>
        <text fg={theme.primary}>:</text>
        <input
          ref={(r) => {
            inputRef = r
            if (vim.mode === "command") {
              setTimeout(() => inputRef.focus(), 1)
            }
          }}
          onInput={(e) => {
            if (e === input()) return
            setLockedQuery(null)
            setSelectedIndex(0)
            setInput(e)
          }}
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
