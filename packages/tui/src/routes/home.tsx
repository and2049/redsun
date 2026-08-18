import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onMount, Show, untrack } from "solid-js"
import { Logo } from "../component/logo"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useEditorContext } from "../context/editor"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { FormPrompt } from "./session/form"
import { Slot } from "../plugin/render"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const data = useData()
  const location = useLocation()
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  // Wide terminals get a proportionally wider prompt rather than a fixed column
  // stranded in the middle of the frame.
  const promptMaxWidth = createMemo(() => Math.max(75, Math.floor(dimensions().width * 0.7)))
  // Global MCP elicitations can arrive without a session route, so keep them reachable from Home.
  const currentLocation = () => route.location ?? data.location.default()
  const forms = createMemo(() => data.session.form.list("global", currentLocation()) ?? [])
  let sent = false

  // Track only the route location and (when absent) the default location; location.set
  // reads other signals internally and tracking them would re-assert the route location
  // after the user overrides it with /cd.
  createEffect(() => {
    const target = currentLocation()
    untrack(() => location.set(target))
  })

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
    r.set({ text: args.prompt, files: [], agents: [], pasted: [] })
    once = true
  }

  // Wait for the model store to be ready before auto-submitting --prompt.
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!local.model.ready) return
    if (!args.prompt) return
    if (r.current.text !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      {/* REDSUN DENSE: the workspace, its branch and the version open the
          frame rather than closing it. The slot keeps its `home.footer` name
          because that path is plugin contract; only where it renders moved. */}
      <box width="100%" flexShrink={0}>
        <Slot path="home.footer" />
      </box>
      {/* The logo and the prompt sit in the middle of the frame with equal air
          above and below, and a hint row between them naming the three prompt
          triggers. */}
      <box flexGrow={1} alignItems="center" paddingLeft={1} paddingRight={1}>
        <box flexGrow={1} minHeight={0} />
        <box flexShrink={0}>
          <Logo />
        </box>
        {/* Content-sized so the column's alignItems="center" centres it under
            the logo, like the logo itself. */}
        <box height={1} flexShrink={0} marginTop={1}>
          <text fg={theme.text.subdued}>/ commands · ! shell · @ files</text>
        </box>
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <Prompt ref={bind} placeholders={placeholder} disabled={forms().length > 0} />
        </box>
        <box flexGrow={1} minHeight={0} />
      </box>
      <Show when={forms()[0]?.id} keyed>
        {(_) => {
          const form = forms()[0]
          return form ? (
            <box position="absolute" zIndex={2000} left={0} right={0} bottom={1} paddingLeft={2} paddingRight={2}>
              <box width="100%">
                <FormPrompt form={form} />
              </box>
            </box>
          ) : null
        }}
      </Show>
    </>
  )
}
