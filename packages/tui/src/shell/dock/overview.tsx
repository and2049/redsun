// Session overview: the dense home for what classic puts in the sidebar.
//
// Dense draws no sidebar, so the `sidebar_title` / `sidebar_content` /
// `sidebar_footer` plugin slots would otherwise render nowhere and the built-in
// panels behind them (todos, changed files, context usage, LSP and MCP status)
// would be invisible. This hosts them in a dialog instead, opened by the same
// `session.sidebar.toggle` command classic binds — so the slot contract, the
// plugins and the keybind all keep working.
//
// It asks for the whole viewport (`xlarge`) and lays the slots out in flow. A
// scrollbox does not render inside the dock's dialog host, so content taller
// than the viewport clips instead of scrolling; taking the full height keeps
// that from biting in practice.
import { TextAttributes } from "@opentui/core"
import { createMemo, onMount, Show } from "solid-js"
import { WorkspaceLabel } from "../../component/workspace-label"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
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

  onMount(() => dialog.setSize("xlarge"))

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
      <box flexGrow={1} minHeight={0} gap={1} paddingTop={1}>
        <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
      </box>
      <box height={1} flexDirection="row" flexShrink={0}>
        <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID} />
      </box>
    </box>
  )
}
