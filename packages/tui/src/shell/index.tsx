// DenseApp: root of the dense native-scrollback shell.
//
// Owns the home-route footerHeight policy for the split-footer renderer: on
// the home route the pinned footer region takes over the whole viewport
// (Claude-style takeover). The session route shrinks the footer to a bottom
// dock and commits the transcript into native scrollback (see session.tsx,
// which owns its own footer-height policy).
import { CliRenderEvents } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, Match, onCleanup, Show, Switch } from "solid-js"
import { PluginRouteMissing } from "../component/plugin-route-missing"
import { StartupLoading } from "../component/startup-loading"
import { CommandBar } from "../component/command-bar"
import { useRoute } from "../context/route"
import { useTuiStartup } from "../context/runtime"
import { usePluginRuntime } from "../plugin/runtime"
import { applyFooterHeight } from "./boot"
import { DenseHome } from "./home"
import { DenseSession } from "./session"

export function DenseApp(props: { ready: () => boolean }) {
  const startup = useTuiStartup()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const pluginRuntime = usePluginRuntime()

  // Home takeover, tracked across terminal resizes. processResize emits
  // RESIZE on every terminal size change, and applyFooterHeight no-ops when
  // the height is already right, so this cannot loop. Non-home routes manage
  // their own footer height.
  const takeover = () => {
    if (route.data.type === "session") return
    applyFooterHeight(renderer, renderer.terminalHeight)
  }
  createEffect(() => {
    void route.data.type
    takeover()
  })
  renderer.on(CliRenderEvents.RESIZE, takeover)
  onCleanup(() => renderer.off(CliRenderEvents.RESIZE, takeover))

  const plugin = createMemo(() => {
    if (!props.ready()) return
    if (route.data.type !== "plugin") return
    const render = pluginRuntime.routes.get(route.data.id)
    if (!render) return <PluginRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data.data })
  })

  return (
    // No painted background: committed scrollback rows sit on the terminal's
    // own background, so painting theme.background here would render the dock
    // as a visibly different slab whenever the two differ.
    <box width={dimensions().width} height={dimensions().height} flexDirection="column">
      <Show when={props.ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>
            <Match when={route.data.type === "home"}>
              <DenseHome />
            </Match>
            <Match when={route.data.type === "session"}>
              <Show when={route.data.type === "session" ? route.data.sessionID : undefined} keyed>
                {(_) => <DenseSession />}
              </Show>
            </Match>
          </Switch>
          {plugin()}
        </box>
        <box flexShrink={0}>
          <pluginRuntime.Slot name="app_bottom" />
        </box>
        <pluginRuntime.Slot name="app" />
        {/* The dense bar renders in flow as the last footer row; the dock's
            height policy reserves DOCK_COMMAND_BAR_ROWS for it. */}
        <CommandBar variant="dense" />
      </Show>
      <Show when={!startup.skipInitialLoading}>
        <StartupLoading ready={props.ready} />
      </Show>
    </box>
  )
}
