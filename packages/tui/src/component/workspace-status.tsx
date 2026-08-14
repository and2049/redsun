// REDSUN DENSE: one-line project/branch readout that sits between the prompt's
// agent/model row and the vim command bar, so the active worktree is always
// visible without opening the sidebar. The right side carries the cline-style
// auto-approve readout (shift+tab or click to toggle).
import { createMemo, Show } from "solid-js"
import { usePermission } from "../context/permission"
import { useProject } from "../context/project"
import { useTuiPaths } from "../context/runtime"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"

export function WorkspaceStatus() {
  const project = useProject()
  const paths = useTuiPaths()
  const sync = useSync()
  const permission = usePermission()
  const { theme } = useTheme()

  const name = createMemo(() => {
    const workspace = project.workspace.current()
    if (workspace) return project.workspace.get(workspace)?.name
    const path = project.instance.path()
    return (path.worktree || path.directory || paths.cwd).split(/[\\/]/).filter(Boolean).at(-1)
  })

  return (
    <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="space-between">
      <Show when={name()} fallback={<text />}>
        {(value) => (
          <text wrapMode="none">
            <span style={{ fg: theme.text }}>{value()}</span>
            <Show when={sync.data.vcs?.branch}>
              {(branch) => <span style={{ fg: theme.textMuted }}> ({branch()})</span>}
            </Show>
          </text>
        )}
      </Show>
      <text wrapMode="none" onMouseDown={() => sync.permission.toggle()}>
        <Show
          when={permission.mode === "auto"}
          fallback={<span style={{ fg: theme.textMuted }}>Auto-approve all disabled (Shift+Tab)</span>}
        >
          <span style={{ fg: theme.success }}>⏵⏵ Auto-approve all enabled </span>
          <span style={{ fg: theme.textMuted }}>(Shift+Tab)</span>
        </Show>
      </text>
    </box>
  )
}
