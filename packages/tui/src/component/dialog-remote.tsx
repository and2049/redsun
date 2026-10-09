import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { renderUnicodeCompact } from "uqr"
import type { RemoteControl } from "@opencode/schema/remote-control"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { remoteLabel, useRemoteControl } from "../context/remote-control"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { Link } from "../ui/link"
import { useLanguage } from "../i18n"

const ROUTE_STATE = {
  off: "remote.tunnelOff",
  issuing: "remote.tunnelIssuing",
  waiting: "remote.tunnelWaiting",
  attaching: "remote.tunnelAttaching",
  ready: "remote.tunnelReady",
  failed: "remote.tunnelFailed",
} satisfies Record<RemoteControl.Tunnel["state"], string>

// Remote access has two audiences on the device tunnel: phones (the passkey-protected companion) and other
// computers' TUIs (the backend itself, paired with a one-time link). Both are set up here; the backend steps
// (enrollment, address, policy) stay behind single actions. Destructive choices sit under Advanced.
export function DialogRemote() {
  const dialog = useDialog()
  dialog.setSize("xlarge")
  const remote = useRemoteControl()
  remote.subscribe()
  const client = useClient()
  const theme = useTheme().surface("dialog")
  const { t } = useLanguage()
  // A TUI attached over the tunnel has no local service registration; the host manages access.
  const attached = () => client.registration === undefined
  const statusLabel = () => t(remote.status()?.state ?? "status unknown")
  const [confirm, setConfirm] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [registering, setRegistering] = createSignal(false)
  createEffect(() => {
    if (!remote.companion()?.running || remote.status()?.state === "connected") setRegistering(false)
  })
  const originPrompt = async () => {
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
            await remote.configure({ origin })
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
  const phonesOn = () => remote.status()?.enabled === true
  const options = createMemo(() => {
    const status = remote.status()
    const tunnel = remote.tunnelState()
    const computers = remote.computersState()
    const rows: DialogSelectOption<string>[] = []
    if (!status?.supported || attached() || !remote.loaded()) return rows
    const phones = t("remote.phones")
    if (!phonesOn())
      rows.push({
        title: t("remote.turnOnPhoneAccess"),
        value: "phones-on",
        description: t("remote.enrollsCreatesTheAddressAndStartsTheCompanion"),
        category: phones,
      })
    else {
      if (remote.companion()?.running && !registering() && status.state !== "connected")
        rows.push({
          title: t("remote.addAPhone"),
          value: "add-phone",
          description: t("remote.opensAFiveMinuteWindowAndShowsTheLink"),
          category: phones,
        })
      if (registering()) rows.push({ title: t("remote.cancelPhoneRegistration"), value: "cancel", category: phones })
      for (const pending of remote.companion()?.pending ?? [])
        rows.push({
          title:
            confirm() === `approve:${pending.requestID}:${pending.fingerprint}`
              ? t("remote.confirmApprove", { fingerprint: pending.fingerprint })
              : t("remote.approvePhone", { fingerprint: pending.fingerprint }),
          value: pending.requestID,
          truncateTitle: false,
          description: t("remote.theFingerprintMustMatchThePhoneScreenExactly"),
          category: phones,
        })
      if (tunnel?.origin) rows.push({ title: t("remote.showPhoneLink"), value: "phone-link", category: phones })
      rows.push({
        title: t("remote.turnOffPhoneAccess"),
        value: "phones-off",
        description: t("remote.theAddressAndRegisteredPhonesAreKept"),
        category: phones,
      })
    }
    const computersTitle = t("remote.computers")
    if (!computers?.enabled)
      rows.push({
        title:
          confirm() === "computers-on"
            ? t("remote.confirmAnyoneWhoPairsGetsFullAccess")
            : t("remote.turnOnComputerAccess"),
        value: "computers-on",
        truncateTitle: false,
        description: confirm() === "computers-on" ? undefined : t("remote.fullAccessForAnyComputerThatPairs"),
        category: computersTitle,
      })
    else {
      rows.push({
        title: t("remote.addAComputer"),
        value: "add-computer",
        description: t("remote.aOneTimeLinkForRedsunAttach"),
        category: computersTitle,
      })
      if (computers.origin)
        rows.push({ title: t("remote.showComputerAddress"), value: "computer-address", category: computersTitle })
      rows.push({
        title: t("remote.turnOffComputerAccess"),
        value: "computers-off",
        description: t("remote.theAddressIsKeptForAttachedComputers"),
        category: computersTitle,
      })
    }
    const advanced = t("remote.advanced")
    if (tunnel?.enabled)
      rows.push({
        title:
          confirm() === "rotate-phone"
            ? t("remote.confirmNewPhoneAddressEveryPhoneMustEnrollAgain")
            : t("remote.newPhoneAddress"),
        value: "rotate-phone",
        truncateTitle: false,
        description: confirm() === "rotate-phone" ? undefined : t("remote.everyPhoneMustRegisterAgain"),
        category: advanced,
      })
    if (computers?.enabled)
      rows.push({
        title:
          confirm() === "rotate-computer"
            ? t("remote.confirmNewComputerAddressEveryComputerMustPairAgain")
            : t("remote.newComputerAddress"),
        value: "rotate-computer",
        truncateTitle: false,
        description: confirm() === "rotate-computer" ? undefined : t("remote.everyComputerMustPairAgain"),
        category: advanced,
      })
    if (status.enrolled) {
      rows.push({
        title: t("remote.useACustomPhoneAddress"),
        value: "origin",
        description: t("remote.anHttpsAddressYouServeYourself"),
        category: advanced,
      })
      rows.push({
        title:
          confirm() === "revoke"
            ? t("remote.confirmForgetAllPhonesAndCredentials")
            : t("remote.forgetAllPhonesAndCredentials"),
        value: "revoke",
        truncateTitle: false,
        description: confirm() === "revoke" ? undefined : t("remote.phoneAccessStartsOverFromEnrollment"),
        category: advanced,
      })
    }
    return rows
  })
  const change = async (action: string) => {
    if (busy()) return
    const pending = remote.companion()?.pending.find((entry) => entry.requestID === action)
    const confirmation = pending ? `approve:${pending.requestID}:${pending.fingerprint}` : action
    if (
      (action === "computers-on" ||
        action === "rotate-phone" ||
        action === "rotate-computer" ||
        action === "revoke" ||
        pending) &&
      confirm() !== confirmation
    ) {
      setConfirm(confirmation)
      return
    }
    setBusy(true)
    if (action === "phones-on") await remote.enableAccess()
    else if (action === "phones-off") await remote.change("disable")
    else if (action === "add-phone") {
      if ((await remote.register()) === true) {
        setRegistering(true)
        const origin = remote.tunnelState()?.origin ?? remote.companion()?.origin
        if (origin) dialog.replace(() => <DialogPhoneLink origin={origin} />)
      }
    } else if (action === "cancel") {
      if (await remote.cancelRegistration()) setRegistering(false)
    } else if (action === "phone-link") {
      const origin = remote.tunnelState()?.origin
      if (origin) dialog.replace(() => <DialogPhoneLink origin={origin} />)
    } else if (action === "computers-on") await remote.configureComputers({ enabled: true })
    else if (action === "computers-off") await remote.configureComputers({ enabled: false })
    else if (action === "add-computer") {
      const pairing = await remote.pair()
      if (pairing)
        dialog.replace(() => <DialogComputerLink link={pairing.link} minutes={Math.round(pairing.expires_in / 60)} />)
    } else if (action === "computer-address") {
      const origin = remote.computersState()?.origin
      if (origin) dialog.replace(() => <DialogComputerLink address={origin} />)
    } else if (action === "rotate-phone") await remote.configureTunnel({ enabled: true, rotate: true })
    else if (action === "rotate-computer") await remote.configureComputers({ enabled: true, rotate: true })
    else if (action === "origin") await originPrompt()
    else if (action === "revoke") await remote.change("revoke")
    else if (pending) {
      if (await remote.approve(pending.requestID, pending.fingerprint)) setRegistering(false)
    }
    setConfirm(undefined)
    setBusy(false)
  }
  const loaded = () => remote.status()?.supported === true && remote.loaded()
  const phonesLine = () => {
    const tunnel = remote.tunnelState()
    const state =
      !phonesOn() || !tunnel?.enabled
        ? t(ROUTE_STATE.off)
        : tunnel.state === "ready" && tunnel.origin
          ? `${t(ROUTE_STATE.ready)} — ${tunnel.origin}`
          : t(ROUTE_STATE[tunnel.state])
    return t("remote.phonesLine", { state })
  }
  const phonesGuidance = () => {
    const status = remote.status()
    if (!status) return t("remote.refreshStatusToSeeTheNextStep")
    if (!status.supported) return t("remote.requiresAManagedServiceRedsunServeServiceThis")
    if (!status.enabled || !remote.loaded()) return undefined
    if (remote.companion()?.error) return remote.companion()?.error
    if (registering())
      return t("remote.openOnThePhoneWithinFiveMinutesAnd", {
        origin: remote.tunnelState()?.origin ?? remote.companion()?.origin ?? "",
      })
    if (status.state === "connected") return t("remote.phoneConnected")
    if (status.state === "ready")
      return remote.phoneRegistered() ? t("remote.phoneRegisteredNotConnected") : t("remote.noPhoneYetChooseAddAPhone")
    return remote.companion()?.running ? t("remote.companionStarting") : undefined
  }
  const computersLine = () => {
    const computers = remote.computersState()
    const state = !computers?.enabled
      ? t(ROUTE_STATE.off)
      : computers.state === "ready" && computers.origin
        ? `${t(ROUTE_STATE.ready)} — ${computers.origin}`
        : t(ROUTE_STATE[computers.state])
    return t("remote.computersLine", { state })
  }
  const warning = () =>
    remote.error() ??
    (remote.tunnelState()?.state === "failed" ? remote.tunnelState()?.error : undefined) ??
    (remote.computersState()?.state === "failed" ? remote.computersState()?.error : undefined) ??
    remote.tunnelState()?.error ??
    remote.computersState()?.error
  return (
    <DialogSelect
      title={t("ui.remoteControl", { status: t(remoteLabel(remote.status())) })}
      titleView={
        <text fg={theme.text.base}>
          {t("remote.remoteAccess") + " "}
          <span style={{ fg: color() }}>{statusLabel()}</span>
        </text>
      }
      renderFilter={false}
      locked={busy()}
      options={options()}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.text.muted}>
            {remote.status()?.supported && attached()
              ? t("remote.manageRemoteAccessOnTheHostComputer")
              : remote.status()?.supported && !remote.loaded()
                ? t("remote.checkingRemoteAccess")
                : t("ui.noItemsAvailable")}
          </text>
        </box>
      }
      onSelect={(option) => void change(option.value)}
      footer={
        <box paddingLeft={2} paddingRight={2}>
          <Show when={loaded()}>
            <text fg={theme.text.base}>{phonesLine()}</text>
          </Show>
          <Show when={phonesGuidance()}>
            {(line) => (
              <text fg={remote.companion()?.error ? theme.text.feedback.warning.base : theme.text.base}>{line()}</text>
            )}
          </Show>
          <Show when={loaded()}>
            <text fg={theme.text.base}>{computersLine()}</text>
          </Show>
          <Show when={warning()}>{(line) => <text fg={theme.text.feedback.warning.base}>{line()}</text>}</Show>
          <Show when={remote.status()?.supported && !remote.status()?.backendID}>
            <text fg={theme.text.feedback.warning.base}>
              {t("remote.backendIdentityHasNotBeenPersistedFixService")}
            </text>
          </Show>
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
        <text fg={theme.text.muted} onMouseUp={() => dialog.replace(() => <DialogRemote />)}>
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

function DialogComputerLink(props: { link?: string; minutes?: number; address?: string }) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const { t } = useLanguage()
  dialog.setSize("large")
  dialog.setCentered(true)
  const value = () => props.link ?? props.address ?? ""
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          {props.link ? t("remote.computerLink") : t("remote.computerAddress")}
        </text>
        <text fg={theme.text.muted} onMouseUp={() => dialog.replace(() => <DialogRemote />)}>
          esc
        </text>
      </box>
      <text fg={theme.text.muted} wrapMode="word">
        {props.link
          ? t("remote.runThisOnTheOtherComputerWithinMinutes", { minutes: props.minutes ?? 5 })
          : t("remote.attachedComputersReachThisRedsunHere")}
      </text>
      <Show when={props.link}>
        <text fg={theme.text.base}>{`redsun attach ${props.link}`}</text>
      </Show>
      <Show when={props.address}>
        {(address) => (
          <Link href={address()} fg={theme.text.base}>
            {address()}
          </Link>
        )}
      </Show>
      <text fg={theme.text.base}>{renderUnicodeCompact(value(), { border: 1 })}</text>
    </box>
  )
}
