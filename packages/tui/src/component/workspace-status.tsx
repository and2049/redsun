// REDSUN DENSE: one-line project/branch readout that sits between the prompt's
// agent/model row and the vim command bar, so the active worktree is always
// visible without opening the sidebar.
import { createMemo, Show } from "solid-js"
import { useProject } from "../context/project"
import { useTuiPaths } from "../context/runtime"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"

export function WorkspaceStatus() {
  const project = useProject()
  const paths = useTuiPaths()
  const sync = useSync()
  const { theme } = useTheme()

  const name = createMemo(() => {
    const workspace = project.workspace.current()
    if (workspace) return project.workspace.get(workspace)?.name
    const path = project.instance.path()
    return (path.worktree || path.directory || paths.cwd).split(/[\\/]/).filter(Boolean).at(-1)
  })

  return (
    <Show when={name()}>
      {(value) => (
        <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1}>
          <text wrapMode="none">
            <span style={{ fg: theme.text }}>{value()}</span>
            <Show when={sync.data.vcs?.branch}>
              {(branch) => <span style={{ fg: theme.textMuted }}> ({branch()})</span>}
            </Show>
          </text>
        </box>
      )}
    </Show>
  )
}
