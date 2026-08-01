// Dense home: full-viewport takeover view shown before the first session.
//
// Reuses the gradient logo and the existing prompt component in its dense
// chrome variant, plus every home plugin slot. On submit the prompt creates a
// session and the route switches to the session view, which commits a banner
// and takes over the dock. The floating `Toast` stays here: home has no dock,
// so it is the only place a notice can land before a session starts.
//
// Home also hosts the dialog stack. The floating overlay is classic-only and
// the dock's inline host only exists on the session route, so without a host
// here every dialog opened from home (session list, agent picker, command
// palette, `:sessions`) would open logically but paint nowhere.
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js"
import { Prompt, type PromptRef } from "../component/prompt"
import { Logo } from "../component/logo"
import { useTuiConfig } from "../config"
import { useArgs } from "../context/args"
import { useEditorContext } from "../context/editor"
import { useLocal } from "../context/local"
import { usePromptRef } from "../context/prompt"
import { useRouteData } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { usePluginRuntime } from "../plugin/runtime"
import { HomeSessionDestinationProvider } from "../routes/home/session-destination"
import { useDialog } from "../ui/dialog"
import { Toast } from "../ui/toast"
import { inlineSelectRows } from "./dock/inline-select"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function DenseHome() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const { theme } = useTheme()
  const dialog = useDialog()
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  const dialogOpen = createMemo(() => dialog.stack.length > 0)
  // Definite height for the open dialog, for the same reason the dock hands
  // one out (dock/index.tsx): classic dialogs lay out with `height="100%"`
  // scrollboxes, which collapse to nothing inside a content-sized column. An
  // inline select declares its exact rows; anything else gets a share of the
  // viewport by its declared size, capped so the prompt below stays visible.
  const dialogRows = createMemo(() => {
    const viewport = Math.max(1, dimensions().height)
    const select = inlineSelectRows()
    if (select > 0) return Math.max(1, Math.min(select, viewport - 4))
    const budget = Math.max(1, viewport - 6)
    const tall = Math.max(20, Math.floor(viewport / 2))
    if (dialog.size === "xlarge") return budget
    if (dialog.size === "large") return Math.min(Math.max(tall, Math.floor((viewport * 3) / 4)), budget)
    return Math.min(tall, budget)
  })
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <HomeSessionDestinationProvider>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_top" mode="single_winner" />
      </box>
      <box flexGrow={1} alignItems="center" paddingLeft={1} paddingRight={1}>
        <box flexGrow={1} minHeight={0} />
        {/* A non-select dialog takes most of the viewport, so the logo yields
            its rows; a picker is compact enough to keep it. */}
        <Show when={!dialogOpen() || inlineSelectRows() > 0}>
          <box flexShrink={0}>
            <pluginRuntime.Slot name="home_logo" mode="replace">
              <Logo />
            </pluginRuntime.Slot>
          </box>
        </Show>
        <Show when={!dialogOpen()}>
          {/* Content-sized so the column's alignItems="center" centres it
              under the logo, like the logo itself. */}
          <box height={1} flexShrink={0} marginTop={1}>
            <text fg={theme.textMuted}>/ commands · ! shell · esc vim</text>
          </box>
        </Show>
        <Show when={dialogOpen()}>
          <box
            width="100%"
            maxWidth={inlineSelectRows() > 0 ? promptMaxWidth() : undefined}
            flexDirection="column"
            flexShrink={0}
            height={dialogRows()}
            minHeight={0}
            marginTop={1}
          >
            {dialog.stack.at(-1)!.element}
          </box>
        </Show>
        {/* The prompt stays mounted under an open dialog (like the dock) so
            commands that write to it through `usePromptRef` find a live ref. */}
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt ref={bind} right={<pluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
          </pluginRuntime.Slot>
        </box>
        <pluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
    </HomeSessionDestinationProvider>
  )
}
