import { Show } from "solid-js"
import { usePermission } from "../context/permission"
import { useTheme } from "../context/theme"

export function WorkspaceStatus() {
  const permission = usePermission()
  const theme = useTheme()

  return (
    <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="flex-end">
      <text wrapMode="none" onMouseDown={() => permission.toggle()}>
        <Show
          when={permission.mode === "auto"}
          fallback={<span style={{ fg: theme.text.subdued }}>Auto-approve all disabled (Shift+Tab)</span>}
        >
          <span style={{ fg: theme.text.feedback.success.default }}>⏵⏵ Auto-approve all enabled </span>
          <span style={{ fg: theme.text.subdued }}>(Shift+Tab)</span>
        </Show>
      </text>
    </box>
  )
}
