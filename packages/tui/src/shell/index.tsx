// DenseApp: root of the dense fullscreen shell.
//
// Same architecture as the classic layout (fullscreen frame, scrollbox
// transcript, floating overlays), restyled: the dense home, the dense prompt
// chrome, and the vim command bar as an in-flow bottom row. The session route
// is the classic one — its scrollbox owns transcript scrolling, and dialogs,
// pickers and autocomplete float over it without reflowing anything.
import { MouseButton } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createMemo, Match, Show, Switch } from "solid-js"
import { PluginRouteMissing } from "../component/plugin-route-missing"
import { StartupLoading } from "../component/startup-loading"
import { CommandBar } from "../component/command-bar"
import { WorkspaceStatus } from "../component/workspace-status"
import { Flag } from "@opencode-ai/core/flag/flag"
import { useClipboard } from "../context/clipboard"
import { useRoute } from "../context/route"
import { useTuiStartup } from "../context/runtime"
import { useTheme } from "../context/theme"
import { usePluginRuntime } from "../plugin/runtime"
import { Session } from "../routes/session"
import { useToast } from "../ui/toast"
import * as Selection from "../util/selection"
import { DenseHome } from "./home"

export function DenseApp(props: { ready: () => boolean }) {
  const startup = useTuiStartup()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const { theme } = useTheme()
  const pluginRuntime = usePluginRuntime()
  const toast = useToast()
  const clipboard = useClipboard()

  const plugin = createMemo(() => {
    if (!props.ready()) return
    if (route.data.type !== "plugin") return
    const render = pluginRuntime.routes.get(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data.data })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast, clipboard)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={
        !Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
          ? () => Selection.copy(renderer, toast, clipboard)
          : undefined
      }
    >
      <Show when={props.ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>
            <Match when={route.data.type === "home"}>
              <DenseHome />
            </Match>
            <Match when={route.data.type === "session"}>
              <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
                {(_) => <Session />}
              </Show>
            </Match>
          </Switch>
          {plugin()}
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>
        <pluginRuntime.Slot name="app" />
        {/* The auto-approve readout is permission state, so the row is
            session-only. */}
        <Show when={route.data.type === "session"}>
          <WorkspaceStatus />
        </Show>
        {/* In flow as the last row of the frame, not floating over content. */}
        <CommandBar />
      </Show>
      <Show when={!startup.skipInitialLoading}>
        <StartupLoading ready={props.ready} />
      </Show>
    </box>
  )
}
