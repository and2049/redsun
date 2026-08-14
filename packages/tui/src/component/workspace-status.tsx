// REDSUN DENSE: the auto-approve readout row (shift+tab or click to toggle).
// The project/branch readout moved into the command bar, so this row only
// carries the cline-style auto-approve status.
import { Show } from "solid-js"
import { usePermission } from "../context/permission"
import { useTheme } from "../context/theme"

export function WorkspaceStatus() {
  const permission = usePermission()
  const { theme } = useTheme()

  return (
    <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="flex-end">
      <text wrapMode="none" onMouseDown={() => permission.toggle()}>
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
