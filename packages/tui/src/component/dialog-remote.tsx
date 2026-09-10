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
          title={t("ui.companionOrigin")}
          value={remote.companion()?.origin ?? detected?.origin ?? ""}
          busy={saving()}
          description={() => <text>{t("ui.mustBeTheHttpsMagicdnsOriginPhonesWill")}</text>}
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
    if (!status) return t("remote.refreshStatusToSeeTheNextStep")
    if (!status.supported) return t("remote.requiresAManagedServiceRedsunServeServiceThis")
    if (!status.enrolled) return t("remote.enrollACompanionBelowOrRunRedsunRemote")
    if (!status.enabled) return t("remote.enableRemoteControlSoTheCompanionCanAttach")
    if (remote.companion()?.error) return remote.companion()?.error
    if (registering())
      return t("remote.openOnThePhoneWithinFiveMinutesAnd", { origin: remote.companion()?.origin ?? "" })
    if (status.state === "unavailable")
      return remote.companion()?.running
        ? t("remote.companionStarting")
        : t("remote.configureACompanionOriginToStartTheCompanion")
    if (status.state === "ready") return t("remote.companionAttachedRegisterOrConnectAPhone")
    if (status.state === "connected") return t("remote.phoneConnected")
  }
  const options = createMemo(() => {
    const status = remote.status()
    const rows: DialogSelectOption<string>[] = []
    if (status?.supported && !status.enabled)
      rows.push({
        title: t("remote.enableRemoteControl"),
        value: "enable",
        description: t("remote.theEnrolledCompanionMayAttachPersistsInThe"),
      })
    if (status?.enabled)
      rows.push({
        title: t("remote.disableRemoteControl"),
        value: "disable",
        description: t("remote.companionAccessEndsImmediatelyEnrollmentAndRunningTasks"),
      })
    if (status?.supported && status.backendID)
      rows.push({
        title: confirm() === "enroll" ? t("remote.confirmEnrollACompanionOnThisHost") : t("remote.enrollACompanion"),
        value: "enroll",
        description: t("remote.storesTheCredentialForTheCompanionOnThis"),
      })
    if (status?.enrolled)
      rows.push({
        title:
          confirm() === "revoke"
            ? t("remote.confirmRevokeAllCompanionCredentials")
            : t("remote.revokeCompanionCredentials"),
        value: "revoke",
        description: t("remote.allCompanionCredentialsAreRemovedCompanionMustEnroll"),
      })
    if (status?.enrolled) rows.push({ title: t("remote.changeCompanionOrigin"), value: "origin" })
    if (remote.companion()?.running) {
      if (!remote.phoneRegistered() && status?.state !== "connected")
        rows.push({ title: t("remote.registerAPhone"), value: "register" })
      if (registering()) rows.push({ title: t("remote.cancelPhoneRegistration"), value: "cancel" })
      for (const pending of remote.companion()?.pending ?? [])
        rows.push({
          title:
            confirm() === `approve:${pending.requestID}:${pending.fingerprint}`
              ? t("remote.confirmApprove", { fingerprint: pending.fingerprint })
              : t("remote.approvePhone", { fingerprint: pending.fingerprint }),
          value: pending.requestID,
          truncateTitle: false,
          description: t("remote.theFingerprintMustMatchThePhoneScreenExactly"),
        })
      if (remote.tailscaleState()?.mapping === "missing")
        rows.push({
          title:
            confirm() === `map:${remote.companion()?.port ?? 43123}`
              ? t("remote.confirm", { command: serveCommand(remote.companion()?.port ?? 43123) })
              : t("remote.mapTailscaleServeToTheCompanion"),
          value: "map",
          truncateTitle: false,
        })
      rows.push({ title: t("remote.inspectTailscaleServe"), value: "tailscale" })
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
      title={t("ui.remoteControl", { status: t(remoteLabel(remote.status())) })}
      titleView={
        <text fg={theme.text.default}>
          {t("remote.remoteControl2") + " "}
          <span style={{ fg: color() }}>{statusLabel()}</span>
        </text>
      }
      renderFilter={false}
      options={options()}
      onSelect={(option) => void change(option.value)}
      footer={
        <box paddingLeft={2} paddingRight={2}>
          <Show when={remote.status()}>
            <text>{remote.status()?.enrolled ? t("remote.enrolled") : t("remote.notEnrolled")}</text>
          </Show>
          <text fg={remote.companion()?.error ? theme.text.feedback.warning.default : theme.text.default}>
            {guidance()}
          </text>
          <Show when={remote.error()}>
            <text fg={theme.text.feedback.warning.default}>{remote.error()}</text>
          </Show>
          <Show when={remote.status()?.supported && !remote.status()?.backendID}>
            <text fg={theme.text.feedback.warning.default}>
              {t("remote.backendIdentityHasNotBeenPersistedFixService")}
            </text>
          </Show>
          <Show when={remote.tailscaleState()?.mapping === "conflict"}>
            <text fg={theme.text.feedback.warning.default}>
              {t("remote.tailscaleServeMappingConflictsInspectTailscaleServeStatus")}
            </text>
          </Show>
          <Show when={remote.tailscaleState() && !remote.tailscaleState()?.certificate}>
            <text>{t("remote.enableHttpsCertificates", { url: "https://tailscale.com/kb/1153/enabling-https" })}</text>
          </Show>
          <text>{t("remote.companionReportedStatusNotATailscaleConnectivityTest")}</text>
        </box>
      }
    />
  )
}
