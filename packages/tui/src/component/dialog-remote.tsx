import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { serveCommand } from "redsun-remote-control"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { remoteLabel, useRemoteControl } from "../context/remote-control"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useLanguage } from "../i18n"

export function DialogRemote() {
  const dialog = useDialog()
  dialog.setSize("xlarge")
  const remote = useRemoteControl()
  remote.subscribe()
  const theme = useTheme("elevated")
  const { t } = useLanguage()
  const statusLabel = () => t(remote.status()?.state ?? "status unknown")
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
          title={t("Companion origin")}
          value={remote.companion()?.origin ?? detected?.origin ?? ""}
          busy={saving()}
          description={() => <text>{t("Must be the https MagicDNS origin phones will open.")}</text>}
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
    if (!status) return t("Refresh status to see the next step.")
    if (!status.supported)
      return t("Requires a managed service (`redsun serve --service`); this backend does not support remote control.")
    if (!status.enrolled)
      return t("Enroll a companion below, or run `redsun remote enroll --handoff <new-private-file>`.")
    if (!status.enabled) return t("Enable remote control so the companion can attach.")
    if (remote.companion()?.error) return remote.companion()?.error
    if (registering())
      return t(
        "Open {{origin}} on the phone within five minutes and choose Register this device; approve the fingerprint here.",
        { origin: remote.companion()?.origin ?? "" },
      )
    if (status.state === "unavailable")
      return remote.companion()?.running
        ? t("Companion starting")
        : t("Configure a companion origin to start the companion.")
    if (status.state === "ready") return t("Companion attached; register or connect a phone")
    if (status.state === "connected") return t("Phone connected")
  }
  const options = createMemo(() => {
    const status = remote.status()
    const rows: DialogSelectOption<string>[] = []
    if (status?.supported && !status.enabled)
      rows.push({
        title: t("Enable remote control"),
        value: "enable",
        description: t("The enrolled companion may attach. Persists in the service configuration."),
      })
    if (status?.enabled)
      rows.push({
        title: t("Disable remote control"),
        value: "disable",
        description: t("Companion access ends immediately; enrollment and running tasks are kept."),
      })
    if (status?.supported && status.backendID)
      rows.push({
        title: confirm() === "enroll" ? t("Confirm: enroll a companion on this host") : t("Enroll a companion"),
        value: "enroll",
        description: t("Stores the credential for the companion on this host. Does not enable remote control."),
      })
    if (status?.enrolled)
      rows.push({
        title:
          confirm() === "revoke" ? t("Confirm: revoke all companion credentials") : t("Revoke companion credentials"),
        value: "revoke",
        description: t("All companion credentials are removed; companion must enroll again. Requires confirmation."),
      })
    if (status?.enrolled) rows.push({ title: t("Change companion origin"), value: "origin" })
    if (remote.companion()?.running) {
      if (!remote.phoneRegistered() && status?.state !== "connected")
        rows.push({ title: t("Register a phone"), value: "register" })
      if (registering()) rows.push({ title: t("Cancel phone registration"), value: "cancel" })
      for (const pending of remote.companion()?.pending ?? [])
        rows.push({
          title:
            confirm() === `approve:${pending.requestID}:${pending.fingerprint}`
              ? t("Confirm: approve {{fingerprint}}", { fingerprint: pending.fingerprint })
              : t("Approve phone {{fingerprint}}", { fingerprint: pending.fingerprint }),
          value: pending.requestID,
          truncateTitle: false,
          description: t("The fingerprint must match the phone screen exactly."),
        })
      if (remote.tailscaleState()?.mapping === "missing")
        rows.push({
          title:
            confirm() === `map:${remote.companion()?.port ?? 43123}`
              ? t("Confirm: {{command}}", { command: serveCommand(remote.companion()?.port ?? 43123) })
              : t("Map Tailscale Serve to the companion"),
          value: "map",
          truncateTitle: false,
        })
      rows.push({ title: t("Inspect Tailscale Serve"), value: "tailscale" })
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
      title={t("Remote control: {{status}}", { status: t(remoteLabel(remote.status())) })}
      titleView={
        <text fg={theme.text.default}>
          {t("Remote control —") + " "}
          <span style={{ fg: color() }}>{statusLabel()}</span>
        </text>
      }
      renderFilter={false}
      options={options()}
      onSelect={(option) => void change(option.value)}
      footer={
        <box paddingLeft={2} paddingRight={2}>
          <Show when={remote.status()}>
            <text>{remote.status()?.enrolled ? t("Enrolled") : t("Not enrolled")}</text>
          </Show>
          <text fg={remote.companion()?.error ? theme.text.feedback.warning.default : theme.text.default}>
            {guidance()}
          </text>
          <Show when={remote.error()}>
            <text fg={theme.text.feedback.warning.default}>{remote.error()}</text>
          </Show>
          <Show when={remote.status()?.supported && !remote.status()?.backendID}>
            <text fg={theme.text.feedback.warning.default}>
              {t(
                "Backend identity has not been persisted; fix service configuration access and run remote disable to initialize it.",
              )}
            </text>
          </Show>
          <Show when={remote.tailscaleState()?.mapping === "conflict"}>
            <text fg={theme.text.feedback.warning.default}>
              {t("Tailscale Serve mapping conflicts; inspect tailscale serve status.")}
            </text>
          </Show>
          <Show when={remote.tailscaleState() && !remote.tailscaleState()?.certificate}>
            <text>
              {t("Enable HTTPS certificates: {{url}}", { url: "https://tailscale.com/kb/1153/enabling-https" })}
            </text>
          </Show>
          <text>{t("Companion-reported status; not a Tailscale connectivity test.")}</text>
        </box>
      }
    />
  )
}
