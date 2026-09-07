import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { serveCommand } from "redsun-remote-control"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { remoteLabel, useRemoteControl } from "../context/remote-control"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"

export function DialogRemote() {
  const dialog = useDialog()
  dialog.setSize("xlarge")
  const remote = useRemoteControl()
  remote.subscribe()
  const theme = useTheme("elevated")
  const [confirm, setConfirm] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [registering, setRegistering] = createSignal(false)
  createEffect(() => {
    if (!remote.companion()?.running || remote.status()?.state === "connected") setRegistering(false)
  })
  let inspected = false
  createEffect(() => {
    if (!remote.companion()?.running || inspected) return
    inspected = true
    void remote.tailscale()
  })
  const originPrompt = async (enable: boolean) => {
    const detected = await remote.tailscale()
    dialog.replace(() => {
      const [saving, setSaving] = createSignal(false)
      return (
        <DialogPrompt
          title="Companion origin"
          value={remote.companion()?.origin ?? detected?.origin ?? ""}
          busy={saving()}
          description={() => <text>Must be the https MagicDNS origin phones will open.</text>}
          onCancel={() => dialog.replace(() => <DialogRemote />)}
          onConfirm={async (origin) => {
            setSaving(true)
            if ((await remote.configure({ origin })) && enable) await remote.change("enable")
            dialog.replace(() => <DialogRemote />)
          }}
        />
      )
    })
  }
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
    if (remote.companion()?.error) return remote.companion()?.error
    if (registering())
      return `Open ${remote.companion()?.origin} on the phone within five minutes and choose Register this device; approve the fingerprint here.`
    if (status.state === "unavailable")
      return remote.companion()?.running ? "Companion starting" : "Configure a companion origin to start the companion."
    if (status.state === "ready") return "Companion attached; register or connect a phone"
    if (status.state === "connected") return "Phone connected"
  }
  const options = createMemo(() => {
    const status = remote.status()
    const rows: DialogSelectOption<string>[] = []
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
        title: confirm() === "enroll" ? "Confirm: enroll a companion on this host" : "Enroll a companion",
        value: "enroll",
        description: "Stores the credential for the companion on this host. Does not enable remote control.",
      })
    if (status?.enrolled)
      rows.push({
        title: confirm() === "revoke" ? "Confirm: revoke all companion credentials" : "Revoke companion credentials",
        value: "revoke",
        description: "All companion credentials are removed; companion must enroll again. Requires confirmation.",
      })
    if (status?.enrolled) rows.push({ title: "Change companion origin", value: "origin" })
    if (remote.companion()?.running) {
      if (!remote.phoneRegistered() && status?.state !== "connected")
        rows.push({ title: "Register a phone", value: "register" })
      if (registering()) rows.push({ title: "Cancel phone registration", value: "cancel" })
      for (const pending of remote.companion()?.pending ?? [])
        rows.push({
          title:
            confirm() === `approve:${pending.requestID}:${pending.fingerprint}`
              ? `Confirm: approve ${pending.fingerprint}`
              : `Approve phone ${pending.fingerprint}`,
          value: pending.requestID,
          truncateTitle: false,
          description: "The fingerprint must match the phone screen exactly.",
        })
      if (remote.tailscaleState()?.mapping === "missing")
        rows.push({
          title:
            confirm() === `map:${remote.companion()?.port ?? 43123}`
              ? `Confirm: ${serveCommand(remote.companion()?.port ?? 43123)}`
              : "Map Tailscale Serve to the companion",
          value: "map",
          truncateTitle: false,
        })
      rows.push({ title: "Inspect Tailscale Serve", value: "tailscale" })
    }
    return rows.map((row) => ({ ...row, disabled: busy() }))
  })
  const change = async (action: string) => {
    if (busy()) return
    const pending = remote.companion()?.pending.find((entry) => entry.requestID === action)
    const confirmation = pending
      ? `approve:${pending.requestID}:${pending.fingerprint}`
      : action === "map"
        ? `map:${remote.companion()?.port ?? 43123}`
        : action
    if ((action === "enroll" || action === "revoke" || action === "map" || pending) && confirm() !== confirmation) {
      setConfirm(confirmation)
      return
    }
    setBusy(true)
    if (action === "enable") await remote.refreshCompanion()
    if (action === "origin" || (action === "enable" && !remote.companion()?.origin))
      await originPrompt(action === "enable")
    else if (action === "enroll") await remote.enroll()
    else if (action === "register") setRegistering((await remote.register()) === true)
    else if (action === "cancel") {
      if (await remote.cancelRegistration()) setRegistering(false)
    } else if (action === "map") await remote.applyTailscale()
    else if (action === "tailscale") await remote.tailscale()
    else if (pending) {
      if (await remote.approve(pending.requestID, pending.fingerprint)) {
        setRegistering(false)
      }
    } else if (action === "enable" || action === "disable" || action === "revoke") await remote.change(action)
    setConfirm(undefined)
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
          <text fg={remote.companion()?.error ? theme.text.feedback.warning.default : theme.text.default}>
            {guidance()}
          </text>
          <Show when={remote.error()}>
            <text fg={theme.text.feedback.warning.default}>{remote.error()}</text>
          </Show>
          <Show when={remote.status()?.supported && !remote.status()?.backendID}>
            <text fg={theme.text.feedback.warning.default}>
              Backend identity has not been persisted; fix service configuration access and run remote disable to
              initialize it.
            </text>
          </Show>
          <Show when={remote.tailscaleState()?.mapping === "conflict"}>
            <text fg={theme.text.feedback.warning.default}>
              Tailscale Serve mapping conflicts; inspect tailscale serve status.
            </text>
          </Show>
          <Show when={remote.tailscaleState() && !remote.tailscaleState()?.certificate}>
            <text>Enable HTTPS certificates: https://tailscale.com/kb/1153/enabling-https</text>
          </Show>
          <text>Companion-reported status; not a Tailscale connectivity test.</text>
        </box>
      }
    />
  )
}
