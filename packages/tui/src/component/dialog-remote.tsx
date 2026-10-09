import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { renderUnicodeCompact } from "uqr"
import type { RemoteControl } from "@opencode/schema/remote-control"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { remoteLabel, useRemoteControl } from "../context/remote-control"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { Link } from "../ui/link"
import { useLanguage } from "../i18n"

const TUNNEL_STATE = {
  off: "remote.tunnelOff",
  issuing: "remote.tunnelIssuing",
  waiting: "remote.tunnelWaiting",
  attaching: "remote.tunnelAttaching",
  ready: "remote.tunnelReady",
  failed: "remote.tunnelFailed",
} satisfies Record<RemoteControl.Tunnel["state"], string>

export function DialogRemote() {
  const dialog = useDialog()
  dialog.setSize("xlarge")
  const remote = useRemoteControl()
  remote.subscribe()
  const theme = useTheme().surface("dialog")
  const { t } = useLanguage()
  const statusLabel = () => t(remote.status()?.state ?? "status unknown")
  const [confirm, setConfirm] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [registering, setRegistering] = createSignal(false)
  createEffect(() => {
    if (!remote.companion()?.running || remote.status()?.state === "connected") setRegistering(false)
  })
  const originPrompt = async (enable: boolean) => {
    dialog.replace(() => {
      const [saving, setSaving] = createSignal(false)
      return (
        <DialogPrompt
          title={t("ui.companionOrigin")}
          value={remote.companion()?.origin ?? ""}
          busy={saving()}
          description={() => <text>{t("ui.anHttpsOriginYouServeYourselfPhonesWill")}</text>}
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
    if (state === "ready" || state === "connected") return theme.text.feedback.success.base
    if (state === "unavailable") return theme.text.feedback.warning.base
    return theme.text.muted
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
    const tunnel = remote.tunnelState()
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
    if (status?.supported && tunnel && !tunnel.enabled)
      rows.push({
        title: t("remote.enablePhoneAccess"),
        value: "tunnel-enable",
        description: t("remote.createsAPublicHttpsAddressForTheCompanion"),
      })
    if (status?.supported && tunnel?.enabled) {
      rows.push({
        title: t("remote.disablePhoneAccess"),
        value: "tunnel-disable",
        description: t("remote.theAddressIsKeptSoEnrolledPhonesKeepWorking"),
      })
      if (tunnel.origin) rows.push({ title: t("remote.showPhoneLink"), value: "link" })
      rows.push({
        title:
          confirm() === "rotate"
            ? t("remote.confirmNewPhoneAddressEveryPhoneMustEnrollAgain")
            : t("remote.rotatePhoneAddress"),
        value: "rotate",
        truncateTitle: false,
      })
    }
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
    }
    return rows.map((row) => ({ ...row, disabled: busy() }))
  })
  // Phone access supplies the companion origin; a manual origin is the fallback when the tunnel cannot be created.
  const enable = async () => {
    await remote.refreshCompanion()
    if (remote.companion()?.origin) {
      await remote.change("enable")
      return
    }
    await remote.refreshTunnel()
    const current = remote.tunnelState()
    const tunnel = current?.enabled ? current : await remote.configureTunnel({ enabled: true })
    if (tunnel?.origin) await remote.change("enable")
    else if (!remote.error()) await originPrompt(true)
  }
  const change = async (action: string) => {
    if (busy()) return
    const pending = remote.companion()?.pending.find((entry) => entry.requestID === action)
    const confirmation = pending ? `approve:${pending.requestID}:${pending.fingerprint}` : action
    if ((action === "enroll" || action === "revoke" || action === "rotate" || pending) && confirm() !== confirmation) {
      setConfirm(confirmation)
      return
    }
    setBusy(true)
    if (action === "enable") await enable()
    else if (action === "origin") await originPrompt(false)
    else if (action === "enroll") await remote.enroll()
    else if (action === "register") setRegistering((await remote.register()) === true)
    else if (action === "cancel") {
      if (await remote.cancelRegistration()) setRegistering(false)
    } else if (action === "tunnel-enable") await remote.configureTunnel({ enabled: true })
    else if (action === "tunnel-disable") await remote.configureTunnel({ enabled: false })
    else if (action === "rotate") await remote.configureTunnel({ enabled: true, rotate: true })
    else if (action === "link") {
      const origin = remote.tunnelState()?.origin
      if (origin) dialog.replace(() => <DialogPhoneLink origin={origin} />)
    } else if (pending) {
      if (await remote.approve(pending.requestID, pending.fingerprint)) {
        setRegistering(false)
      }
    } else if (action === "disable" || action === "revoke") await remote.change(action)
    setConfirm(undefined)
    setBusy(false)
  }
  const tunnelLine = (tunnel: RemoteControl.Tunnel) => {
    const state = t("remote.phoneAccess", { state: t(TUNNEL_STATE[tunnel.state]) })
    return tunnel.state !== "off" && tunnel.origin ? `${state} — ${tunnel.origin}` : state
  }
  return (
    <DialogSelect
      title={t("ui.remoteControl", { status: t(remoteLabel(remote.status())) })}
      titleView={
        <text fg={theme.text.base}>
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
          <text fg={remote.companion()?.error ? theme.text.feedback.warning.base : theme.text.base}>
            {guidance()}
          </text>
          <Show when={remote.error()}>
            <text fg={theme.text.feedback.warning.base}>{remote.error()}</text>
          </Show>
          <Show when={remote.status()?.supported && !remote.status()?.backendID}>
            <text fg={theme.text.feedback.warning.base}>
              {t("remote.backendIdentityHasNotBeenPersistedFixService")}
            </text>
          </Show>
          <Show when={remote.status()?.supported && remote.tunnelState()}>
            {(tunnel) => (
              <text fg={tunnel().state === "failed" ? theme.text.feedback.warning.base : theme.text.base}>
                {tunnelLine(tunnel())}
              </text>
            )}
          </Show>
          <Show when={remote.tunnelState()?.error}>
            {(error) => <text fg={theme.text.feedback.warning.base}>{error()}</text>}
          </Show>
          <text>{t("remote.companionReportedStatusNotAPhoneConnectivityTest")}</text>
        </box>
      }
    />
  )
}

function DialogPhoneLink(props: { origin: string }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const { t } = useLanguage()
  dialog.setSize("large")
  dialog.setCentered(true)
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          {t("remote.phoneLink")}
        </text>
        <text fg={theme.text.muted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.text.muted} wrapMode="word">
        {t("remote.scanToOpenTheCompanionOnAPhone")}
      </text>
      <Link href={props.origin} fg={theme.text.base}>
        {props.origin}
      </Link>
      <text fg={theme.text.base}>{renderUnicodeCompact(props.origin, { border: 1 })}</text>
    </box>
  )
}
