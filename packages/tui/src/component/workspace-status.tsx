import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { usePermission } from "../context/permission"
import { useTheme } from "../context/theme"
import { remoteLabel, useRemoteControl } from "../context/remote-control"

export function WorkspaceStatus() {
  const permission = usePermission()
  const theme = useTheme()
  const remote = useRemoteControl()
  const dimensions = useTerminalDimensions()
  const compact = () => dimensions().width < 80

  return (
    <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="flex-end">
      <text wrapMode="none" fg={theme.text.subdued}>
        {remoteLabel(remote.status(), compact())}{" "}
      </text>
      <text wrapMode="none" onMouseDown={() => permission.toggle()}>
        <Show
          when={permission.mode === "auto"}
          fallback={
            <span style={{ fg: theme.text.subdued }}>
              {compact() ? "Auto-approve: off" : "Auto-approve all disabled (Shift+Tab)"}
            </span>
          }
        >
          <span style={{ fg: theme.text.feedback.success.default }}>
            {compact() ? "Auto-approve: on" : "⏵⏵ Auto-approve all enabled "}
          </span>
          <Show when={!compact()}>
            <span style={{ fg: theme.text.subdued }}>(Shift+Tab)</span>
          </Show>
        </Show>
      </text>
    </box>
  )
}
