// Dense inline replacement for the modal `DialogSelect`.
//
// Honours the same `DialogSelectProps` contract so every existing picker
// (command palette, model, agent, theme, session list, variant, worker model,
// skill, …) renders in the dock without touching its own file: `DialogSelect`
// early-returns into this component when `tui.ui` is dense.
//
// Differences from the modal version, all deliberate density choices:
// - no backdrop, no panel background, no 4-column padding;
// - category headers collapse into a dim right-aligned suffix instead of
//   taking their own row;
// - the list is a fixed window centred on the selection rather than a
//   scrollbox, so the dock can size itself exactly (see `rows`).
// - `details` rows are dropped (the dock has no room for per-option detail).
//
// Keybindings, command names, action handling and selection semantics are kept
// identical to `DialogSelect` so keybind config and existing tests still apply.
import { InputRenderable, RGBA, TextAttributes } from "@opentui/core"
import * as fuzzysort from "fuzzysort"
import { entries, flatMap, groupBy, isDeepEqual, pipe } from "remeda"
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTuiConfig } from "../../config"
import { selectedForeground, useTheme } from "../../context/theme"
import { formatKeyBindings, useBindings, useKeymapSelector } from "../../keymap"
import { useDialog } from "../../ui/dialog"
import type { DialogSelectOption, DialogSelectProps, DialogSelectRef } from "../../ui/dialog-select"

// Maximum option rows rendered at once. The dock grows to fit up to this many
// and windows the list beyond it.
export const INLINE_SELECT_MAX_ROWS = 8

const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)

// The dock sizes the footer region to the active inline select. Exactly one is
// mounted at a time (the dialog stack renders only its top entry), and dialog
// elements are constructed at their call site — outside the dock's context
// subtree — so a module-level signal is both sufficient and necessary here.
const [rows, setRows] = createSignal(0)

/** Rows the mounted inline select wants, or 0 when none is mounted. */
export const inlineSelectRows = rows

export function InlineSelect<T>(props: DialogSelectProps<T>) {
  type Action = NonNullable<DialogSelectProps<T>["actions"]>[number]
  type FooterHint = NonNullable<DialogSelectProps<T>["footerHints"]>[number]
  type VisibleAction = (Action & { label: string }) | FooterHint

  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()

  const [store, setStore] = createStore({ selected: 0, filter: "" })
  const [focusedAction, setFocusedAction] = createSignal<number>()
  let selection: { value: T; category?: string } | undefined
  let input: InputRenderable | undefined

  const renderFilter = createMemo(() => props.renderFilter !== false)

  const filtered = createMemo(() => {
    const options = props.options.filter((option) => option.disabled !== true)
    if (props.skipFilter || !renderFilter()) return options
    const needle = store.filter.toLowerCase()
    if (!needle) return options
    // Same weighting as the modal picker: title matches beat category matches.
    return fuzzysort
      .go(needle, options, { keys: ["title", "category"], scoreFn: (r) => r[0].score * 2 + r[1].score })
      .map((result) => result.obj)
  })

  // Grouping only fixes the ordering here — the category itself is rendered as
  // a dim suffix on each row rather than as a header row.
  const flat = createMemo(() =>
    pipe(
      filtered(),
      groupBy((option) => option.category ?? ""),
      entries(),
      flatMap(([, options]) => options),
    ),
  )

  const selected = createMemo(() => flat()[store.selected])
  const listRows = createMemo(() => Math.max(1, Math.min(INLINE_SELECT_MAX_ROWS, flat().length || 1)))

  const actions = createMemo(() => (props.actions ?? []).filter((action) => !action.hidden))
  const actionBindings = useKeymapSelector((keymap) =>
    keymap.getCommandBindings({ visibility: "registered", commands: actions().map((action) => action.command) }),
  )
  const visibleActions = createMemo<VisibleAction[]>(() => [
    ...actions()
      .map((action) => ({ ...action, label: formatKeyBindings(actionBindings().get(action.command), tuiConfig) ?? "" }))
      .filter((action) => action.label),
    ...(props.footerHints ?? []),
  ])
  const actionItems = createMemo(() =>
    visibleActions()
      .filter(isActionItem)
      .filter((action) => !isActionDisabled(action)),
  )
  const footerVisible = createMemo(() => Boolean(props.footer) || visibleActions().length > 0)

  const desiredRows = createMemo(
    () => 1 + (renderFilter() ? 1 : 0) + listRows() + (footerVisible() ? 1 : 0),
  )
  createEffect(() => setRows(desiredRows()))
  onCleanup(() => setRows(0))

  // Window the list around the selection so the visible slice always contains it.
  const offset = createMemo(() => {
    const total = flat().length
    const size = listRows()
    if (total <= size) return 0
    const centred = store.selected - Math.floor(size / 2)
    return Math.max(0, Math.min(centred, total - size))
  })
  const windowed = createMemo(() => flat().slice(offset(), offset() + listRows()))

  createEffect(() => {
    const index = focusedAction()
    if (index !== undefined && index >= actionItems().length) setFocusedAction(undefined)
  })

  // Track `current` the way the modal picker does: jump to it when it changes.
  createEffect(
    on(
      () => props.current,
      (current) => {
        if (current === undefined) return
        const index = flat().findIndex((option) => isDeepEqual(option.value, current))
        if (index < 0) return
        setStore("selected", index)
        selection = flat()[index]
      },
    ),
  )

  // Keep the selection pinned to its value while the option list churns
  // (async model/session loading), and clamp it when the list shrinks.
  createEffect(
    on(
      () => props.options,
      () => {
        const list = flat()
        if (list.length === 0) return
        if (props.preserveSelection && selection) {
          const index = list.findIndex((option) => isDeepEqual(option.value, selection!.value))
          if (index >= 0) {
            setStore("selected", index)
            selection = list[index]
            return
          }
        }
        if (store.selected >= list.length) {
          setStore("selected", list.length - 1)
          selection = list[store.selected]
        }
      },
    ),
  )

  // Filtering restarts at the top; the modal picker does the same.
  createEffect(
    on(
      () => store.filter,
      (value) => {
        if (!value) return
        setStore("selected", 0)
        selection = flat()[0]
      },
      { defer: true },
    ),
  )

  function move(direction: number) {
    if (props.locked) return
    const total = flat().length
    if (total === 0) return
    let next = store.selected + direction
    if (next < 0) next = total - 1
    if (next >= total) next = 0
    moveTo(next)
  }

  function moveTo(next: number) {
    if (props.locked) return
    setFocusedAction(undefined)
    setStore("selected", next)
    const option = selected()
    if (!option) return
    selection = option
    props.onMove?.(option)
  }

  function submit() {
    if (props.locked) return
    const index = focusedAction()
    if (index !== undefined) {
      triggerAction(actionItems()[index])
      return
    }
    const option = selected()
    if (!option) return
    option.onSelect?.(dialog)
    props.onSelect?.(option)
  }

  function moveAction(direction: 1 | -1) {
    if (props.locked) return
    const total = actionItems().length
    if (total === 0) return
    setFocusedAction((index) => {
      if (index === undefined) return direction === 1 ? 0 : total - 1
      const next = index + direction
      return next < 0 || next >= total ? undefined : next
    })
  }

  function isActionItem(item: VisibleAction): item is Action & { label: string } {
    return "onTrigger" in item
  }

  function isActionDisabled(item: Action) {
    return typeof item.disabled === "function" ? item.disabled(selected()) : item.disabled
  }

  function triggerAction(item: VisibleAction | undefined) {
    if (props.locked) return
    if (!item || !isActionItem(item) || isActionDisabled(item)) return
    const option = selected()
    if (!option) return
    item.onTrigger(option)
  }

  useBindings(() => {
    const visible = actions()
    return {
      commands: [
        { name: "dialog.select.prev", title: "Previous item", category: "Dialog", run: () => move(-1) },
        { name: "dialog.select.next", title: "Next item", category: "Dialog", run: () => move(1) },
        { name: "dialog.select.page_up", title: "Page up", category: "Dialog", run: () => move(-INLINE_SELECT_MAX_ROWS) },
        {
          name: "dialog.select.page_down",
          title: "Page down",
          category: "Dialog",
          run: () => move(INLINE_SELECT_MAX_ROWS),
        },
        { name: "dialog.select.home", title: "First item", category: "Dialog", run: () => moveTo(0) },
        {
          name: "dialog.select.end",
          title: "Last item",
          category: "Dialog",
          run: () => moveTo(Math.max(0, flat().length - 1)),
        },
        { name: "dialog.select.submit", title: "Select item", category: "Dialog", run: submit },
        ...visible.map((item) => ({
          name: item.command,
          title: item.title,
          category: "Dialog",
          run() {
            if (props.locked) return
            if (isActionDisabled(item)) return
            const option = selected()
            if (!option) return
            item.onTrigger(option)
          },
        })),
      ],
      bindings: [
        ...tuiConfig.keybinds.gather("dialog.select", [
          "dialog.select.prev",
          "dialog.select.next",
          "dialog.select.page_up",
          "dialog.select.page_down",
          "dialog.select.home",
          "dialog.select.end",
          "dialog.select.submit",
        ]),
        ...visible.flatMap((item) => tuiConfig.keybinds.get(item.command)),
        ...(visible.length
          ? [
              { key: "tab", desc: "Next dialog action", group: "Dialog", cmd: () => moveAction(1) },
              { key: "shift+tab", desc: "Previous dialog action", group: "Dialog", cmd: () => moveAction(-1) },
            ]
          : []),
        ...(props.bindings ?? []).filter((binding) => {
          if (typeof binding.cmd !== "string") return true
          return visible.some((item) => item.command === binding.cmd)
        }),
      ],
    }
  })

  const ref: DialogSelectRef<T> = {
    get filter() {
      return store.filter
    },
    get filtered() {
      return filtered()
    },
    moveTo(value) {
      const index = flat().findIndex((option) => isDeepEqual(option.value, value))
      if (index >= 0) moveTo(index)
    },
  }
  props.ref?.(ref)

  const counter = createMemo(() => {
    const total = flat().length
    if (total === 0) return ""
    return `${Math.min(store.selected + 1, total)}/${total}`
  })

  function Row(row: { option: DialogSelectOption<T> }) {
    const active = createMemo(() => !props.locked && isDeepEqual(row.option.value, selected()?.value))
    const current = createMemo(() => isDeepEqual(row.option.value, props.current))
    const fg = createMemo(() => {
      if (active() && focusedAction() === undefined) return selectedForeground(theme)
      if (current()) return theme.primary
      return theme.text
    })
    const meta = createMemo(() =>
      active() && focusedAction() === undefined ? selectedForeground(theme) : theme.textMuted,
    )
    const trailing = createMemo(() => row.option.footer ?? row.option.category)

    return (
      <box
        height={1}
        flexDirection="row"
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={active() ? (row.option.bg ?? theme.primary) : TRANSPARENT}
        onMouseUp={() => {
          if (props.locked) return
          row.option.onSelect?.(dialog)
          props.onSelect?.(row.option)
        }}
      >
        <text flexShrink={0} fg={fg()} wrapMode="none">
          {current() ? "●" : " "}
        </text>
        <Show when={row.option.gutter}>
          <box flexShrink={0}>{row.option.gutter?.()}</box>
        </Show>
        <text
          flexGrow={1}
          fg={fg()}
          wrapMode="none"
          overflow="hidden"
          attributes={active() ? TextAttributes.BOLD : undefined}
        >
          {row.option.titleView ?? row.option.title}
          <Show when={row.option.description}>
            <span style={{ fg: meta() }}> {row.option.description}</span>
          </Show>
        </text>
        <Show when={typeof trailing() === "string" ? trailing() : undefined}>
          <text flexShrink={0} fg={meta()} wrapMode="none">
            {trailing() as string}
          </text>
        </Show>
      </box>
    )
  }

  function FooterAction(entry: { item: VisibleAction }) {
    const item = entry.item
    if (!isActionItem(item))
      return (
        <text wrapMode="none">
          <span style={{ fg: theme.text }}>{item.title}</span>
          <span style={{ fg: theme.textMuted }}> {item.label}</span>
        </text>
      )
    const active = createMemo(() => !props.locked && actionItems().indexOf(item) === focusedAction())
    const disabled = createMemo(() => isActionDisabled(item))
    return (
      <text wrapMode="none" onMouseUp={() => triggerAction(item)}>
        <span style={{ fg: disabled() ? theme.textMuted : active() ? theme.primary : theme.text, bold: active() }}>
          {item.title}
        </span>
        <span style={{ fg: theme.textMuted }}> {item.label}</span>
      </text>
    )
  }

  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <box height={1} flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}>
        <Show when={props.titleView} fallback={<text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">{props.title}</text>}>
          {props.titleView}
        </Show>
        <text flexGrow={1} fg={theme.textMuted} wrapMode="none">
          {counter()}
        </text>
        <text flexShrink={0} fg={theme.textMuted} wrapMode="none" onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show when={renderFilter()}>
        <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
          <text flexShrink={0} fg={theme.primary}>
            {"❯ "}
          </text>
          <input
            flexGrow={1}
            onInput={(value: string) => {
              if (props.locked) return
              batch(() => {
                setStore("filter", value)
                props.onFilter?.(value)
              })
            }}
            focusedTextColor={theme.text}
            cursorColor={theme.primary}
            placeholder={props.placeholder ?? "Search"}
            placeholderColor={theme.textMuted}
            ref={(r: InputRenderable) => {
              input = r
              input.traits = { status: "FILTER" }
              setTimeout(() => {
                if (!input || input.isDestroyed) return
                input.focus()
              }, 1)
            }}
          />
        </box>
      </Show>
      <Show
        when={flat().length > 0}
        fallback={
          props.emptyView ?? (
            <box height={1} paddingLeft={1}>
              <text fg={theme.textMuted}>No results found</text>
            </box>
          )
        }
      >
        <box flexDirection="column" flexShrink={0}>
          <For each={windowed()}>{(option) => <Row option={option} />}</For>
        </box>
      </Show>
      <Show when={footerVisible()}>
        <box height={1} flexDirection="row" gap={2} paddingLeft={1} paddingRight={1}>
          {props.footer}
          <For each={visibleActions()}>{(item) => <FooterAction item={item} />}</For>
        </box>
      </Show>
    </box>
  )
}
