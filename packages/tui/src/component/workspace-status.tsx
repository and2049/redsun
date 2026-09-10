import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { usePermission } from "../context/permission"
import { useTheme } from "../context/theme"
import { useRemoteControl } from "../context/remote-control"
import { useLanguage } from "../i18n"

export function WorkspaceStatus() {
  const permission = usePermission()
  const theme = useTheme()
  const remote = useRemoteControl()
  const dimensions = useTerminalDimensions()
  const language = useLanguage()
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
              {compact() ? language.t("permission.autoApprove.off") : language.t("permission.autoApprove.disabled")}
            </span>
          }
        >
          <span style={{ fg: theme.text.feedback.success.default }}>
            {compact() ? language.t("permission.autoApprove.on") : `⏵⏵ ${language.t("permission.autoApprove.enabled")}`}
          </span>
          <Show when={!compact()}>
            <span style={{ fg: theme.text.subdued }}>(Shift+Tab)</span>
          </Show>
        </Show>
      </text>
    </box>
  )
}
