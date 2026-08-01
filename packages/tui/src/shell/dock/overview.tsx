// Session overview: the dense home for what classic puts in the sidebar.
//
// Dense draws no sidebar, so the `sidebar_title` / `sidebar_content` /
// `sidebar_footer` plugin slots would otherwise render nowhere and the built-in
// panels behind them (todos, changed files, context usage, LSP and MCP status)
// would be invisible. This hosts them in a tall-dock dialog instead, opened by
// the same `session.sidebar.toggle` command classic binds — so the slot
// contract, the plugins and the keybind all keep working.
//
// Like the classic sidebar it scrolls, which only works because the dock gives
// non-select dialogs a definite height: a scrollbox inside a content-sized
// column collapses to nothing and takes its siblings with it.
import type { ScrollBoxRenderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { createMemo, Show } from "solid-js"
import { WorkspaceLabel } from "../../component/workspace-label"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../keymap"
import { usePluginRuntime } from "../../plugin/runtime"
import { useDialog } from "../../ui/dialog"

export function SessionOverview(props: { sessionID: string }) {
  const sync = useSync()
  const project = useProject()
  const pluginRuntime = usePluginRuntime()
  const dialog = useDialog()
  const { theme } = useTheme()

  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    return workspaceID ? project.workspace.get(workspaceID) : undefined
  }

  let scroll: ScrollBoxRenderable | undefined
  const by = (rows: number) => () => {
    if (!scroll || scroll.isDestroyed) return
    scroll.scrollBy(rows)
  }

  // The dock has no focused editor here, so the view drives its own scrolling
  // rather than relying on the scrollbox's own focus handling.
  useBindings(() => ({
    bindings: [
      { key: "up", desc: "Scroll up", group: "Overview", cmd: by(-1) },
      { key: "k", desc: "Scroll up", group: "Overview", cmd: by(-1) },
      { key: "down", desc: "Scroll down", group: "Overview", cmd: by(1) },
      { key: "j", desc: "Scroll down", group: "Overview", cmd: by(1) },
      { key: "pageup", desc: "Page up", group: "Overview", cmd: by(-10) },
      { key: "pagedown", desc: "Page down", group: "Overview", cmd: by(10) },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <pluginRuntime.Slot
          name="sidebar_title"
          mode="single_winner"
          session_id={props.sessionID}
          title={session()?.title ?? ""}
          share_url={session()?.share?.url}
        >
          <box flexDirection="column">
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
              {session()?.title ?? "Session"}
            </text>
            <Show when={workspace()}>
              {(item) => (
                <text fg={theme.textMuted} wrapMode="none" truncate>
                  <WorkspaceLabel
                    type={item().type}
                    name={item().name}
                    status={project.workspace.status(item().id) ?? "error"}
                    icon
                  />
                </text>
              )}
            </Show>
            <Show when={session()?.share?.url}>
              <text fg={theme.textMuted} wrapMode="none" truncate>
                {session()!.share!.url}
              </text>
            </Show>
          </box>
        </pluginRuntime.Slot>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <scrollbox ref={(item: ScrollBoxRenderable) => (scroll = item)} flexGrow={1} minHeight={0}>
        <box flexShrink={0} gap={1} paddingTop={1}>
          <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
        </box>
      </scrollbox>
      <box height={1} flexDirection="row" onMouseUp={() => dialog.clear()}>
        <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID} />
      </box>
    </box>
  )
}
