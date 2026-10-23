import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import {
  batch,
  children,
  createContext,
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  useContext,
  type JSX,
  type ParentProps,
} from "solid-js"
import { Keymap } from "../context/keymap"
import { ThemeContextProvider, useTheme, useThemes } from "../context/theme"
import { InputRenderable, MouseButton, Renderable, RGBA, TextAttributes, type OptimizedBuffer } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useToast } from "./toast"
import { useClipboard } from "../context/clipboard"
import { useConfig, useNewDesigns } from "../config"
import { SplitBorder } from "./border"
import { copy, copyOnSelectRelease } from "../util/selection"
import { DEFAULT_INTENT, setTerminalBackgroundGain } from "../util/terminal-background"

const BACKDROP_GAIN = 1 - 150 / 255

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/**
 * REDSUN: dims the finished frame behind a dialog. OpenTUI 0.6 records paint hooks and lets none of them read the
 * frame, so this runs as a renderer post-process over the composed frame and skips the dialog's own rectangle.
 * Under the terminal's own background, cells still showing it keep their background (which would otherwise be
 * painted over a transparent or image background) and only their text dims.
 */
function dimBehind(buffer: OptimizedBuffer, dialog: Rect | undefined, gain: number, keepTerminalBackground: boolean) {
  const width = buffer.width
  const cells = width * buffer.height
  // Raw planes are readable and writable inside the post-process scope. A cell colour is four u16
  // channels with the colour in the low byte and its metadata (the terminal-default intent) above.
  const { fg, bg } = buffer.buffers
  for (let cell = 0; cell < cells; cell++) {
    const x = cell % width
    const y = (cell - x) / width
    if (dialog && x >= dialog.x && x < dialog.x + dialog.width && y >= dialog.y && y < dialog.y + dialog.height)
      continue
    const i = cell * 4
    scaleColor(fg, i, gain)
    if (keepTerminalBackground && bg[i + 1]! >>> 8 === DEFAULT_INTENT) continue
    scaleColor(bg, i, gain)
  }
}

function scaleColor(plane: Uint16Array, offset: number, gain: number) {
  for (let channel = offset; channel < offset + 3; channel++) {
    const value = plane[channel]!
    plane[channel] = (value & 0xff00) | Math.round((value & 0xff) * gain)
  }
}

export type DialogSize = "medium" | "large" | "xlarge"

export type DialogPlacement = "default" | "bottom"

export const DIALOG_INSET = 3
// List rows reserve a 1-cell gutter for the ▌ bar / ● marker.
export const DIALOG_LIST_INSET = DIALOG_INSET + 1

export function dialogWidth(size: DialogSize) {
  if (size === "xlarge") return 116
  if (size === "large") return 88
  return 60
}

export function Dialog(
  props: ParentProps<{
    size?: DialogSize
    centered?: boolean
    placement?: DialogPlacement
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const theme = useTheme().surface("dialog")
  const themes = useThemes()
  const renderer = useRenderer()
  const bottom = () => props.placement === "bottom"
  let inner: Renderable | undefined

  createEffect(() => {
    setTerminalBackgroundGain(renderer, bottom() ? 1 : BACKDROP_GAIN)
  })
  onCleanup(() => setTerminalBackgroundGain(renderer, 1))
  createEffect(() => {
    if (bottom()) return
    const keepTerminalBackground = themes.terminalBackground()
    const dim = (buffer: OptimizedBuffer) => {
      const box = inner && !inner.isDestroyed ? inner : undefined
      dimBehind(buffer, box && { x: box.x, y: box.y, width: box.width, height: box.height }, BACKDROP_GAIN, keepTerminalBackground)
    }
    renderer.addPostProcessFn(dim)
    onCleanup(() => renderer.removePostProcessFn(dim))
  })

  let dismiss = false
  return (
    <ThemeContextProvider context="dialog">
      <box
        onMouseDown={() => {
          dismiss = !!renderer.getSelection()
        }}
        onMouseUp={() => {
          if (dismiss) {
            dismiss = false
            return
          }
          props.onClose?.()
        }}
        width={dimensions().width}
        height={dimensions().height}
        alignItems={bottom() ? "stretch" : "center"}
        justifyContent={bottom() ? "flex-end" : props.centered ? "center" : undefined}
        position="absolute"
        zIndex={3000}
        paddingTop={bottom() || props.centered ? 0 : dimensions().height / 4}
        left={0}
        top={0}
      >
        <box
          ref={(box) => (inner = box)}
          onMouseUp={(e: { stopPropagation(): void }) => {
            // A selection release must bubble up to the copy-on-select handler in
            // DialogProvider; the backdrop's dismiss flag keeps it from closing the dialog.
            if (renderer.getSelection()?.getSelectedText()) return
            dismiss = false
            e.stopPropagation()
          }}
          width={bottom() ? "100%" : dialogWidth(props.size ?? "medium")}
          maxWidth={bottom() ? dimensions().width : dimensions().width - 2}
          border={bottom() ? SplitBorder.border : false}
          customBorderChars={bottom() ? SplitBorder.customBorderChars : undefined}
          borderColor={bottom() ? theme.border.base : undefined}
          backgroundColor={theme.background.base}
        >
          <box backgroundColor={bottom() ? theme.background.raised.high : undefined} paddingTop={1}>
            {props.children}
          </box>
        </box>
      </box>
    </ThemeContextProvider>
  )
}

export function DialogHeader(
  props: ParentProps<{
    title?: JSX.Element
    titleView?: JSX.Element
    closeLabel?: string
    onClose?: () => void
    gap?: number
    /** Faint line below the title. Shown only under the "new-designs" experiment. */
    description?: string
  }>,
) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const newDesigns = useNewDesigns()
  const row = () => (
    <box flexDirection="row" justifyContent="space-between" gap={props.gap}>
      {props.titleView ?? (
        <text attributes={newDesigns() ? undefined : TextAttributes.BOLD} fg={theme.text.base}>
          {props.title}
        </text>
      )}
      {props.children}
      <text
        fg={newDesigns() ? theme.text.faint : theme.text.muted}
        flexShrink={0}
        onMouseUp={() => (props.onClose ?? dialog.clear)()}
      >
        {props.closeLabel ?? "esc"}
      </text>
    </box>
  )
  return (
    <Show when={newDesigns() && props.description} fallback={row()}>
      <box>
        {row()}
        <text fg={theme.text.faint} wrapMode="word">
          {props.description}
        </text>
      </box>
    </Show>
  )
}

/**
 * Standard dialog layout: header, body and an optional footer, one blank row between
 * each and one blank row at the bottom, with the shared side padding.
 */
export function DialogLayout(
  props: ParentProps<{
    id?: string
    /** Usually a `DialogHeader`. */
    header: JSX.Element
    /** Rendered as a `DialogFooter`. */
    footer?: DialogFooterProps
    /** Footer shown while the "new-designs" experiment is off. Remove when the experiment graduates. */
    legacyFooter?: JSX.Element
    /** Side padding in cells. Defaults to DIALOG_INSET. */
    inset?: number
    /** Blank rows between the body and the footer under the "new-designs" experiment. Defaults to 1. */
    footerGap?: number
  }>,
) {
  const inset = () => props.inset ?? DIALOG_INSET
  const newDesigns = useNewDesigns()
  return (
    <box id={props.id} paddingLeft={inset()} paddingRight={inset()} paddingBottom={1} gap={1}>
      {props.header}
      <box paddingBottom={newDesigns() && props.footer ? (props.footerGap ?? 1) - 1 : 0}>{props.children}</box>
      <Show when={newDesigns() || props.legacyFooter === undefined} fallback={props.legacyFooter}>
        <Show when={props.footer}>
          {(footer) => (
            <DialogFooter actions={footer().actions} inset={footer().inset}>
              {footer().children}
            </DialogFooter>
          )}
        </Show>
      </Show>
    </box>
  )
}

/** Stretches a raised band inside a `DialogLayout` across the side padding; its content re-applies `DIALOG_INSET`. */
export function DialogBleed(props: ParentProps) {
  return (
    <box marginLeft={-DIALOG_INSET} marginRight={-DIALOG_INSET}>
      {props.children}
    </box>
  )
}

export type DialogFooterAction = {
  title: string
  /** Literal key label, e.g. "enter". */
  key?: string
  /** Keymap command id whose first shortcut is shown when `key` is not set. The action hides when it has no shortcut. */
  command?: string
  onTrigger?: () => void
  disabled?: boolean
  /** Overrides the title and key color, e.g. for a "copied ✓" confirmation. */
  color?: RGBA
}

/**
 * Alignment separates scope: `secondary` holds dialog-level actions on the left, `primary` holds actions
 * on the selected item (or the dialog's main action) on the right.
 */
export type DialogFooterActions = {
  secondary?: DialogFooterAction[]
  primary?: DialogFooterAction[]
}

export type DialogFooterProps = ParentProps<{
  actions?: DialogFooterActions
  /** Side padding in cells, e.g. DIALOG_INSET or DIALOG_LIST_INSET. Omit when the parent already pads. */
  inset?: number
}>

export function DialogFooter(props: DialogFooterProps) {
  const dimensions = useTerminalDimensions()
  const shortcuts = Keymap.useShortcuts()
  const theme = useTheme().surface("dialog")
  const newDesigns = useNewDesigns()
  const narrow = () => dimensions().width < 60
  const resolve = (actions: DialogFooterAction[] = []) =>
    actions.flatMap((action) => {
      if (action.key !== undefined || action.command === undefined) return [action]
      const key = shortcuts.get(action.command)
      return key ? [{ ...action, key }] : []
    })
  const secondary = () => resolve(props.actions?.secondary)
  const primary = () => resolve(props.actions?.primary)
  const content = children(() => props.children)
  // The raised band bleeds across the parent's DIALOG_INSET padding and the layout's bottom row,
  // so it spans the dialog edge to edge and sits flush with its bottom.
  const band = () => newDesigns() && (secondary().length > 0 || primary().length > 0 || content.toArray().length > 0)
  // Hoverable actions carry one cell of padding on each side; the band gives that cell back so labels keep their column.
  const bandInset = () => DIALOG_INSET + (props.inset ?? 0) - 1
  return (
    <box
      marginLeft={band() ? -DIALOG_INSET : undefined}
      marginRight={band() ? -DIALOG_INSET : undefined}
      marginBottom={band() ? -1 : undefined}
      paddingLeft={band() ? bandInset() : props.inset}
      paddingRight={band() ? bandInset() : props.inset}
      paddingTop={band() ? 1 : undefined}
      paddingBottom={band() ? 1 : undefined}
      backgroundColor={band() ? theme.background.raised.high : undefined}
      flexDirection="row"
      justifyContent="space-between"
      gap={newDesigns() ? 2 : undefined}
      flexShrink={0}
    >
      <box
        flexDirection={narrow() ? "column" : "row"}
        gap={narrow() || newDesigns() ? 0 : 2}
        columnGap={newDesigns() && !narrow() ? 1 : undefined}
        // Under new designs the primary group keeps its width and the secondary group wraps instead of overlapping.
        flexWrap={newDesigns() ? "wrap" : undefined}
        flexShrink={newDesigns() ? 1 : undefined}
        minWidth={newDesigns() ? 0 : undefined}
      >
        {content()}
        <For each={secondary()}>{(action) => <DialogFooterItem action={action} variant="secondary" />}</For>
      </box>
      <box flexDirection="row" gap={newDesigns() ? 1 : 2} flexShrink={newDesigns() ? 0 : undefined}>
        <For each={primary()}>{(action) => <DialogFooterItem action={action} variant="primary" />}</For>
      </box>
    </box>
  )
}

function DialogFooterItem(props: { action: DialogFooterAction; variant: "primary" | "secondary" }) {
  const theme = useTheme().surface("dialog")
  const newDesigns = useNewDesigns()
  const [hovered, setHovered] = createSignal(false)
  const trigger = () => {
    if (props.action.disabled) return
    props.action.onTrigger?.()
  }
  const label = (key: RGBA) => (
    <>
      <span
        style={{
          fg: props.action.disabled ? theme.text.action.primary.disabled : (props.action.color ?? theme.text.base),
        }}
      >
        {props.action.title}
      </span>
      <Show when={props.action.key}>
        <span style={{ fg: props.action.disabled ? theme.text.action.primary.disabled : (props.action.color ?? key) }}>
          {" " + props.action.key}
        </span>
      </Show>
    </>
  )
  return (
    <Show when={newDesigns()} fallback={<text onMouseUp={trigger}>{label(theme.text.muted)}</text>}>
      <box
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
        backgroundColor={
          hovered() && !props.action.disabled ? theme.background.action[props.variant].hovered : undefined
        }
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={trigger}
      >
        <text>{label(theme.text.faint)}</text>
      </box>
    </Show>
  )
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as {
      element: () => JSX.Element
      onClose?: () => void
      key?: unknown
    }[],
    size: "medium" as DialogSize,
    centered: false,
    placement: "default" as DialogPlacement,
  })

  const renderer = useRenderer()
  const keymap = Keymap.use()

  createEffect(() => {
    if (store.stack.length === 0) return
    const popMode = keymap.mode.push("modal")
    onCleanup(popMode)
  })

  let focus: Renderable | null
  function refocus() {
    setTimeout(() => {
      if (store.stack.length > 0) return
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    enabled: store.stack.length > 0,
    commands: [
      {
        bind: "escape",
        title: "Close dialog",
        group: "Dialog",
        run: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
            return
          }
          const current = store.stack.at(-1)
          current?.onClose?.()
          setStore("stack", store.stack.slice(0, -1))
          refocus()
        },
      },
      {
        bind: "ctrl+c",
        title: "Close dialog",
        group: "Dialog",
        run: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
            return
          }
          const editor = renderer.currentFocusedEditor
          if (editor?.plainText) {
            if (editor instanceof InputRenderable) editor.value = ""
            else editor.setText("")
            return
          }
          const current = store.stack.at(-1)
          current?.onClose?.()
          setStore("stack", store.stack.slice(0, -1))
          refocus()
        },
      },
    ],
  }))

  return {
    clear() {
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      batch(() => {
        setStore("size", "medium")
        setStore("centered", false)
        setStore("placement", "default")
        setStore("stack", [])
      })
      refocus()
    },
    replace(input: () => JSX.Element, onClose?: () => void, options?: { key?: unknown; size?: DialogSize }) {
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      batch(() => {
        setStore("size", options?.size ?? "medium")
        setStore("centered", false)
        setStore("placement", "default")
        setStore("stack", [
          {
            element: input,
            onClose,
            key: options?.key,
          },
        ])
      })
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    get centered() {
      return store.centered
    },
    get key() {
      return store.stack.at(-1)?.key
    },
    setSize(size: "medium" | "large" | "xlarge") {
      setStore("size", size)
    },
    setCentered(centered: boolean) {
      setStore("centered", centered)
    },
    get placement() {
      return store.placement
    },
    setPlacement(placement: DialogPlacement) {
      setStore("placement", placement)
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  const clipboard = useClipboard()
  const config = useConfig()
  const copyOnSelectEnabled = () =>
    (config.data.terminal?.copy ?? (process.platform === "win32" ? "manual" : "select")) === "select"

  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        zIndex={3000}
        onMouseDown={(evt: { button: number; preventDefault(): void; stopPropagation(): void }) => {
          if (copyOnSelectEnabled()) return
          if (evt.button !== MouseButton.RIGHT) return

          if (!copy(renderer, toast, clipboard)) return
          evt.preventDefault()
          evt.stopPropagation()
        }}
        onMouseUp={
          copyOnSelectEnabled() ? (event) => copyOnSelectRelease(event, renderer, toast, clipboard) : undefined
        }
      >
        <Show when={value.stack.length}>
          <Dialog onClose={() => value.clear()} size={value.size} centered={value.centered} placement={value.placement}>
            {/* Render each entry once: inserting the element function directly would re-run it, remounting
                the dialog with fresh state, whenever a signal it reads at its root (e.g. a top-level <Show>) changes. */}
            <Show when={value.stack.at(-1)} keyed>
              {(item) => item.element()}
            </Show>
          </Dialog>
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}
