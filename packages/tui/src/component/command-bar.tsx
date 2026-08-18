// REDSUN DENSE: the frame's last row.
//
// Idle it is a status line — the workspace on the left, the session's context
// and cost on the right. In command mode it becomes a `:` bar with fuzzy
// completion. It participates in the dock's column layout rather than floating
// over the transcript, so opening it never moves anything.
import { InputRenderable, type KeyEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import fuzzysort from "fuzzysort"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { commandAliases, resolveCommand } from "../vim"
import { useVim } from "../context/vim"
import { Keymap } from "../context/keymap"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { SplitBorder } from "../ui/border"
import { fitSessionUsage, sessionUsage } from "../util/session-usage"

const MAX_SUGGESTIONS = 10

export function CommandBar() {
  const vim = useVim()
  const theme = useTheme()
  const keymap = Keymap.use()
  const commandList = Keymap.useCommands()
  const dimensions = useTerminalDimensions()
  const route = useRoute()
  const data = useData()
  const location = useLocation()
  const [input, setInput] = createSignal("")
  const [selected, setSelected] = createSignal(-1)
  let inputRef: InputRenderable | undefined

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const workspace = createMemo(() => {
    if (!sessionID()) return undefined
    const current = location.current
    if (!current) return undefined
    if (current.workspaceID) return current.workspaceID
    return current.directory.split(/[\\/]/).filter(Boolean).at(-1)
  })
  const branch = createMemo(() => data.location.vcs.info(location.current)?.branch.current)

  const usage = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    const models = data.location.model.list(location.current)
    return sessionUsage({
      messages: data.session.message.list(id) ?? [],
      contextLimit: (model) =>
        models?.find((item) => item.providerID === model.providerID && item.id === model.id)?.limit.context,
      cost: data.session.cost(id),
    })
  })
  const usageLabel = createMemo(() => {
    if (vim.mode === "command") return undefined
    const current = usage()
    if (!current) return undefined
    const left = (workspace()?.length ?? 0) + (branch()?.length ?? 0) + 4
    return fitSessionUsage(current, Math.max(0, dimensions().width - left - 4))
  })

  /** Every reachable command, plus its slash name, aliases, and the `:` aliases. */
  const commands = createMemo(() => {
    const result = new Map<string, { target: string; description: string }>()
    for (const command of commandList()) {
      if (!command.id) continue
      const entry = { target: command.id, description: command.title ?? command.description ?? command.id }
      result.set(command.id, entry)
      if (command.slash?.name) result.set(command.slash.name, entry)
      for (const alias of command.slash?.aliases ?? []) result.set(alias, entry)
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
    // Read the mode before the ref guard: the <input> only exists while the bar
    // is in command mode, so an early return that has not tracked the mode
    // leaves the effect subscribed to nothing and the bar never takes focus.
    const mode = vim.mode
    if (!inputRef) return
    if (mode !== "command") {
      inputRef.blur()
      return
    }
    inputRef.focus()
    setSelected(-1)
    // Claim the input mode so no other layer's bindings fire while typing.
    onCleanup(keymap.mode.push("command"))
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
      // Dispatch after the mode has settled, so a command that opens a dialog
      // is not immediately closed by the mode change behind it.
      if (command) setTimeout(() => keymap.dispatch(command.target))
      return
    }
    if (event.name !== "tab") return
    event.preventDefault()
    const list = suggestions()
    if (list.length === 0) return
    const next =
      selected() < 0
        ? event.shift
          ? list.length - 1
          : 0
        : (selected() + (event.shift ? -1 : 1) + list.length) % list.length
    setSelected(next)
    setInput(list[next]!)
  })

  return (
    <box
      position="relative"
      width="100%"
      flexShrink={0}
      height={1}
      zIndex={1000}
      backgroundColor={vim.mode === "command" ? theme.background.surface.offset : theme.background.default}
      flexDirection="row"
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
    >
      <Switch>
        <Match when={vim.mode === "command"}>
          <text fg={theme.text.action.primary.selected}>:</text>
          <input
            ref={(value: InputRenderable) => (inputRef = value)}
            value={input()}
            onInput={(value: string) => {
              setInput(value)
              setSelected(-1)
            }}
            focusedBackgroundColor={theme.background.surface.offset}
            focusedTextColor={theme.text.default}
            cursorColor={theme.text.action.primary.selected}
            flexGrow={1}
          />
          {/* The menu grows upward out of the bar, over the transcript, so the
              frame's rows never move when it opens. */}
          <Show when={suggestions().length > 0}>
            <box
              position="absolute"
              bottom={1}
              left={0}
              width={Math.min(56, dimensions().width)}
              flexDirection="column"
              backgroundColor={theme.background.surface.overlay}
              border={["left"]}
              customBorderChars={SplitBorder.customBorderChars}
              borderColor={theme.border.default}
              zIndex={100}
            >
              <For each={suggestions()}>
                {(suggestion, index) => (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={index() === selected() ? theme.background.action.primary.selected : undefined}
                  >
                    <text
                      fg={index() === selected() ? theme.text.action.primary.focused : theme.text.default}
                      wrapMode="none"
                    >
                      {suggestion}{" "}
                      <span
                        style={{
                          fg: index() === selected() ? theme.text.action.primary.focused : theme.text.subdued,
                        }}
                      >
                        — {commands().get(suggestion)?.description}
                      </span>
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>
        </Match>
        <Match when={true}>
          <box flexDirection="row" flexGrow={1} justifyContent="space-between">
            <Show when={workspace()}>
              {(value) => (
                <text wrapMode="none">
                  <span style={{ fg: theme.text.default }}>{value()}</span>
                  <Show when={branch()}>{(name) => <span style={{ fg: theme.text.subdued }}> ({name()})</span>}</Show>
                </text>
              )}
            </Show>
            <box flexDirection="row" flexShrink={0}>
              {/* A pending count is only meaningful until the next motion, so it
                  shows here rather than in the prompt where it would linger. */}
              <Show when={vim.pendingCount()}>
                {(count) => (
                  <text fg={theme.text.default} wrapMode="none">
                    {count()}{" "}
                  </text>
                )}
              </Show>
              <Show when={usageLabel()}>
                {(value) => (
                  <text fg={theme.text.subdued} wrapMode="none">
                    {value()}
                  </text>
                )}
              </Show>
            </box>
          </box>
        </Match>
      </Switch>
    </box>
  )
}
