import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { usePermission } from "../context/permission"
import { useTheme } from "../context/theme"
import { useRemoteControl } from "../context/remote-control"

export function WorkspaceStatus() {
  const permission = usePermission()
  const theme = useTheme()
  const remote = useRemoteControl()
  const dimensions = useTerminalDimensions()
  const compact = () => dimensions().width < 80
  const rcState = () => remote.status()?.state
  const rcColor = () =>
    rcState() === "unavailable" ? theme.text.feedback.warning.default : theme.text.feedback.success.default

  return (
    <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1} flexDirection="row" justifyContent="flex-end">
      <Show when={rcState() === "ready" || rcState() === "connected" || rcState() === "unavailable"}>
        <text wrapMode="none" fg={rcColor()}>
          {"/RC "}
        </text>
      </Show>
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
