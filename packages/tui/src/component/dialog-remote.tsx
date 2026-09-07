import { createMemo, createSignal, Show } from "solid-js"
import os from "node:os"
import path from "node:path"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { remoteLabel, useRemoteControl } from "../context/remote-control"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"

export function DialogRemote(props: { handoff?: string } = {}) {
  const dialog = useDialog()
  const remote = useRemoteControl()
  const theme = useTheme("elevated")
  const [confirm, setConfirm] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const color = () => {
    const state = remote.status()?.state
    if (state === "ready" || state === "connected") return theme.text.feedback.success.default
    if (state === "unavailable") return theme.text.feedback.warning.default
    return theme.text.subdued
  }
  const guidance = () => {
    const status = remote.status()
    if (!status) return "Refresh status to see the next step."
    if (!status.supported)
      return "Requires a managed service (`redsun serve --service`); this backend does not support remote control."
    if (!status.enrolled) return "Enroll a companion below, or run `redsun remote enroll --handoff <new-private-file>`."
    if (!status.enabled) return "Enable remote control so the companion can attach."
    if (status.state === "unavailable")
      return "Enabled, but no live companion heartbeat. Start the companion (or run its `check-backend`); the lease expires after 30 seconds."
    if (status.state === "ready") return "Companion attached; no browser connected."
    if (status.state === "connected") return "Browser connected through the companion."
  }
  const options = createMemo(() => {
    const status = remote.status()
    const rows: DialogSelectOption<"enable" | "disable" | "enroll" | "revoke">[] = []
    if (status?.supported && !status.enabled)
      rows.push({
        title: "Enable remote control",
        value: "enable",
        description: "The enrolled companion may attach. Persists in the service configuration.",
      })
    if (status?.enabled)
      rows.push({
        title: "Disable remote control",
        value: "disable",
        description: "Companion access ends immediately; enrollment and running tasks are kept.",
      })
    if (status?.supported && status.backendID)
      rows.push({
        title: "Enroll a companion",
        value: "enroll",
        description: "Creates a private handoff file to import on the companion. Does not enable remote control.",
      })
    if (status?.enrolled)
      rows.push({
        title: confirm() ? "Confirm: revoke all companion credentials" : "Revoke companion credentials",
        value: "revoke",
        description: "All companion credentials are removed; companion must enroll again. Requires confirmation.",
      })
    return rows.map((row) => ({ ...row, disabled: busy() }))
  })
  const change = async (action: "enable" | "disable" | "enroll" | "revoke") => {
    if (busy()) return
    if (action === "enroll") {
      setConfirm(false)
      dialog.replace(() => <DialogRemoteEnroll />)
      return
    }
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
      titleView={
        <text fg={theme.text.default}>
          Remote control — <span style={{ fg: color() }}>{remote.status()?.state ?? "status unknown"}</span>
        </text>
      }
      renderFilter={false}
      options={options()}
      onSelect={(option) => void change(option.value)}
      footer={
        <box paddingLeft={2} paddingRight={2}>
          <Show when={remote.status()}>
            <text>{remote.status()?.enrolled ? "Enrolled" : "Not enrolled"}</text>
          </Show>
          <text>{guidance()}</text>
          <Show when={remote.status()?.supported && !remote.status()?.backendID}>
            <text fg={theme.text.feedback.warning.default}>
              Backend identity has not been persisted; fix service configuration access and run remote disable to
              initialize it.
            </text>
          </Show>
          <Show when={props.handoff}>
            <text>
              Private handoff: {props.handoff}. Import on the companion with `import-backend &lt;path&gt;` in
              redsun-remote-control.{remote.status()?.enabled ? "" : " Then enable remote control."}
            </text>
          </Show>
          <text>Companion-reported status; not a Tailscale connectivity test.</text>
          <Show when={remote.error()}>
            <text fg={theme.text.feedback.warning.default}>{remote.error()}</text>
          </Show>
        </box>
      }
    />
  )
}

function DialogRemoteEnroll() {
  const dialog = useDialog()
  const remote = useRemoteControl()
  const theme = useTheme("elevated")
  const [busy, setBusy] = createSignal(false)
  const enroll = async (value: string) => {
    if (busy() || !value.trim()) return
    setBusy(true)
    const file = await remote.enroll(value.trim())
    setBusy(false)
    if (file) dialog.replace(() => <DialogRemote handoff={file} />)
  }
  return (
    <DialogPrompt
      title="Enroll companion"
      value={path.join(os.tmpdir(), `redsun-remote-handoff-${Date.now()}.json`)}
      busy={busy()}
      description={() => (
        <box>
          <text>
            Creates a private handoff file containing a companion credential. Import it on the companion; never send it
            to a browser. Choose a new file path.
          </text>
          <Show when={remote.error()}>
            <text fg={theme.text.feedback.warning.default}>{remote.error()}</text>
          </Show>
        </box>
      )}
      onConfirm={(value) => void enroll(value)}
    />
  )
}
