import { InputRenderable, TextAttributes, type KeyEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import fuzzysort from "fuzzysort"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { useVim } from "../context/vim"
import { selectedForeground, useTheme } from "../context/theme"
import { useOpencodeKeymap, useOpencodeModeStack, useKeymapSelector } from "../keymap"
import { commandAliases, resolveCommand } from "../vim"
import { SplitBorder } from "../ui/border"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { fitSessionUsage, sessionUsage } from "../util/session-usage"

const MAX_SUGGESTIONS = 10

export function CommandBar() {
  const vim = useVim()
  const { theme } = useTheme()
  const keymap = useOpencodeKeymap()
  const modeStack = useOpencodeModeStack()
  const dimensions = useTerminalDimensions()
  const route = useRoute()
  const sync = useSync()
  const entries = useKeymapSelector((value) =>
    value.getCommandEntries({
      visibility: "reachable",
      namespace: "palette",
      filter: (command) => command.hidden !== true,
    }),
  )
  const [input, setInput] = createSignal("")
  const [selected, setSelected] = createSignal(-1)
  let inputRef: InputRenderable

  const modeLabel = createMemo(() => (vim.tempRemaining() != null ? `normal (${vim.tempRemaining()}s)` : vim.mode))
  const usage = createMemo(() => {
    const current = route.data
    if (current.type !== "session") return undefined
    return sessionUsage({
      messages: sync.data.message[current.sessionID] ?? [],
      providers: sync.data.provider,
      cost: sync.session.get(current.sessionID)?.cost ?? 0,
    })
  })
  const usageLabel = createMemo(() => {
    if (vim.mode === "command") return undefined
    const current = usage()
    if (!current) return undefined
    return fitSessionUsage(current, Math.max(0, dimensions().width - modeLabel().length - 4))
  })

  const commands = createMemo(() => {
    const result = new Map<string, { target: string; description: string }>()
    for (const entry of entries()) {
      const description =
        typeof entry.command.desc === "string"
          ? entry.command.desc
          : typeof entry.command.title === "string"
            ? entry.command.title
            : entry.command.name
      result.set(entry.command.name, { target: entry.command.name, description })
      if (typeof entry.command.slashName === "string") {
        result.set(entry.command.slashName, { target: entry.command.name, description })
      }
      if (Array.isArray(entry.command.slashAliases)) {
        for (const alias of entry.command.slashAliases) result.set(alias, { target: entry.command.name, description })
      }
    }
    for (const [alias, target] of Object.entries(commandAliases)) {
      const entry = result.get(target)
      if (entry) result.set(alias, entry)
    }
    return result
  })

  const suggestions = createMemo(() => {
    const query = input().trim().toLowerCase()
    if (!query) return []
    return fuzzysort
      .go(query, Array.from(commands().keys()))
      .map((result) => result.target)
      .slice(0, MAX_SUGGESTIONS)
  })

  createEffect(() => {
    const mode = vim.mode
    if (!inputRef) return
    if (mode === "command") {
      inputRef.focus()
      setSelected(-1)
      onCleanup(modeStack.push("command"))
      return
    }
    inputRef.blur()
  })

  const close = () => {
    inputRef?.blur()
    setInput("")
    setSelected(-1)
    vim.setMode("normal")
  }

  useKeyboard((event: KeyEvent) => {
    if (vim.mode !== "command") return
    if (event.name === "escape") {
      event.preventDefault()
      close()
      return
    }
    if (event.name === "return") {
      event.preventDefault()
      const command = commands().get(resolveCommand(input()))
      close()
      if (command) setTimeout(() => keymap.dispatchCommand(command.target))
      return
    }
    if (event.name !== "tab") return
    event.preventDefault()
    const list = suggestions()
    if (list.length === 0) return
    const next = selected() < 0
      ? event.shift
        ? list.length - 1
        : 0
      : (selected() + (event.shift ? -1 : 1) + list.length) % list.length
    setSelected(next)
    setInput(list[next])
  })

  return (
    <box
      position="absolute"
      bottom={0}
      left={0}
      width={dimensions().width}
      height={1}
      zIndex={1000}
      backgroundColor={vim.mode === "command" ? theme.backgroundElement : theme.background}
      flexDirection="row"
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
    >
      <Switch>
        <Match when={vim.mode === "command"}>
          <text fg={theme.primary}>:</text>
          <input
            ref={(value: InputRenderable) => (inputRef = value)}
            value={input()}
            onInput={(value) => {
              setInput(value)
              setSelected(-1)
            }}
            focusedBackgroundColor={theme.backgroundElement}
            focusedTextColor={theme.text}
            cursorColor={theme.primary}
            flexGrow={1}
          />
          <Show when={suggestions().length > 0}>
            <box
              position="absolute"
              bottom={1}
              left={0}
              width={Math.min(56, dimensions().width)}
              flexDirection="column"
              backgroundColor={theme.backgroundMenu}
              {...SplitBorder}
              borderColor={theme.border}
              zIndex={100}
            >
              <For each={suggestions()}>
                {(suggestion, index) => (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={index() === selected() ? theme.primary : undefined}
                  >
                    <text fg={index() === selected() ? selectedForeground(theme) : theme.text} wrapMode="none">
                      {suggestion} <span style={{ fg: index() === selected() ? selectedForeground(theme) : theme.textMuted }}>- {commands().get(suggestion)?.description}</span>
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>
        </Match>
        <Match when={true}>
          <box flexDirection="row" flexGrow={1} justifyContent="space-between">
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              {modeLabel()}
            </text>
            <Show when={usageLabel()}>
              {(value) => (
                <text fg={theme.textMuted} wrapMode="none">
                  {value()}
                </text>
              )}
            </Show>
          </box>
        </Match>
      </Switch>
    </box>
  )
}
