import { createSignal, Show } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { remoteLabel, useRemoteControl } from "../context/remote-control"

export function DialogRemote() {
  const remote = useRemoteControl()
  const [confirm, setConfirm] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const change = async (action: "enable" | "disable" | "revoke") => {
    if (busy()) return
    if (action === "revoke" && !confirm()) {
      setConfirm(true)
      return
    }
    setBusy(true)
    await remote.change(action)
    setConfirm(false)
    setBusy(false)
  }
  return (
    <DialogSelect
      title={`Remote control: ${remoteLabel(remote.status())}`}
      renderFilter={false}
      options={[
        { title: "Enable remote control", value: "enable" as const, disabled: busy() || !remote.status()?.supported },
        {
          title: "Disable remote control (keep enrollment and running tasks)",
          value: "disable" as const,
          disabled: busy(),
        },
        {
          title: confirm()
            ? "Confirm: revoke all companion credentials"
            : "Revoke companion credentials (requires enrollment again)",
          value: "revoke" as const,
          disabled: busy(),
        },
      ]}
      onSelect={(option) => void change(option.value)}
      footer={
        <box paddingLeft={2} paddingRight={2}>
          <text>Companion-reported status; not a Tailscale connectivity test.</text>
          <text>Enroll locally with redsun remote enroll --handoff &lt;new-private-file&gt;</text>
          <Show when={remote.error()}>
            <text>{remote.error()}</text>
          </Show>
        </box>
      }
    />
  )
}
