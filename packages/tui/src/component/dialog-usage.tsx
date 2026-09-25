import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useTerminalDimensions } from "@opentui/solid"
import { Usage } from "@opencode/plugin/usage"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useTheme } from "../context/theme"
import { useConfig } from "../config"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { providerRowTitle } from "../util/provider-menu"

// Keep last-known quotas across dialog mounts, isolated by server client, location and account.
// Weak ownership prevents one server's quotas leaking into another connection.
const cached = new WeakMap<object, Map<string, Usage.Snapshot>>()
const indent = "      "

export function usageBar(percent: number, width: number) {
  const size = Math.max(1, Math.floor(width))
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * size)
  return "█".repeat(filled) + "░".repeat(size - filled)
}

function resetLabel(reset: string) {
  // ISO timestamps are absolute. Keep native Claude reset text and Kiro billing dates intact.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(reset)) return reset
  const date = new Date(reset)
  if (!Number.isFinite(date.getTime())) return reset
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function DialogUsage() {
  const dialog = useDialog()
  const client = useClient()
  const data = useData()
  const location = useLocation()
  const config = useConfig()
  const toast = useToast()
  const theme = useTheme("elevated")
  const dimensions = useTerminalDimensions()
  dialog.setPlacement("bottom")
  const [revision, refresh] = createSignal(0)
  let selection: DialogSelectRef<string> | undefined
  const [saving, setSaving] = createSignal(false)
  const [snapshots, setSnapshots] = createStore<Record<string, Usage.Snapshot | undefined>>({})
  const [loading, setLoading] = createStore<Record<string, boolean>>({})
  const integrations = createMemo(() => data.location.integration.list(location.ref) ?? [])
  const candidates = createMemo(() =>
    Usage.providers.filter((provider) =>
      integrations().some(
        (integration) =>
          integration.id === provider.id &&
          integration.connections.some((connection) => connection.type === "credential"),
      ),
    ),
  )

  const collapsed = (id: string) => config.data.usage?.collapsed?.includes(id) === true

  for (const provider of Usage.providers) {
    const isCollapsed = createMemo(() => collapsed(provider.id))
    const key = createMemo(() => {
      const integration = integrations().find((item) => item.id === provider.id)
      if (!integration?.connections.some((item) => item.type === "credential")) return
      return JSON.stringify([location.ref, provider.id, integration.connections])
    })
    createEffect(() => {
      revision()
      const accountKey = key()
      const closed = isCollapsed()
      const api = client.api
      let cache = cached.get(api)
      if (!cache) cached.set(api, (cache = new Map()))
      const previous = accountKey ? cache.get(accountKey) : undefined
      setSnapshots(provider.id, previous)
      setLoading(provider.id, false)
      if (!accountKey || closed) return
      const ref = location.ref
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      setLoading(provider.id, true)
      const failed = (message: string): Usage.Snapshot => ({
        ...previous,
        connected: true,
        windows: previous?.windows ?? [],
        updatedAt: previous?.updatedAt ?? Date.now(),
        message: previous?.windows.length ? `Showing last available usage. ${message}` : message,
      })
      void api
        .rpc(Usage.rpc(provider.id))
        .read(undefined, { location: ref, signal: controller.signal })
        .then((snapshot) => {
          if (controller.signal.aborted) return
          if (!snapshot.connected) cache.delete(accountKey)
          else if (snapshot.windows.length) {
            // Bound retention when many projects/accounts are used in one TUI process.
            cache.delete(accountKey)
            cache.set(accountKey, snapshot)
            if (cache.size > 100) cache.delete(cache.keys().next().value!)
          }
          setSnapshots(
            provider.id,
            snapshot.connected && !snapshot.windows.length && snapshot.message ? failed(snapshot.message) : snapshot,
          )
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          const missing =
            typeof error === "object" && error !== null && "type" in error && error.type === "rpc.method_not_found"
          if (missing) cache.delete(accountKey)
          setSnapshots(
            provider.id,
            missing
              ? { connected: false, windows: [], updatedAt: Date.now() }
              : failed("Usage is unavailable. Check the connection or update the redsun server."),
          )
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(provider.id, false)
        })
    })
  }

  const current = () => selection?.selected?.value ?? options()[0]?.value
  async function change(id: string | undefined = current(), collapse?: boolean) {
    if (!id || saving()) return
    const next = collapse ?? !collapsed(id)
    setSaving(true)
    await config
      .update((draft) => {
        const values = new Set<string>(draft.usage?.collapsed ?? [])
        if (next) values.add(id)
        else values.delete(id)
        draft.usage ??= {}
        draft.usage.collapsed = [...values]
      })
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  const options = createMemo(() =>
    candidates()
      .toSorted((a, b) => Number(collapsed(a.id)) - Number(collapsed(b.id)))
      .flatMap((provider) => {
        const snapshot = snapshots[provider.id]
        if (snapshot?.connected === false) return []
        const details: NonNullable<DialogSelectOption["details"]> = []
        if (!collapsed(provider.id)) {
          if (loading[provider.id] && !snapshot) details.push(`${indent}Loading usage…`)
          if (snapshot) {
            for (const window of snapshot.windows) {
              const width = Math.max(4, Math.min(20, dimensions().width - 42))
              details.push(
                `${indent}${window.label.padEnd(7)} ${usageBar(window.usedPercent, width)} ${Number(window.usedPercent.toFixed(1))}% used`,
              )
              if (window.detail) details.push({ text: `${indent}${window.detail}`, color: theme.text.subdued })
              if (window.reset)
                details.push({ text: `${indent}Resets ${resetLabel(window.reset)}`, color: theme.text.subdued })
            }
            if (snapshot.message) details.push({ text: `${indent}${snapshot.message}`, color: theme.text.subdued })
          }
        }
        return [
          {
            value: provider.id,
            title: providerRowTitle(provider.label, !collapsed(provider.id)),
            description: !collapsed(provider.id) && loading[provider.id] && snapshot ? "refreshing…" : undefined,
            details,
            detailsColor: theme.text.default,
            onSelect: () => void change(provider.id),
          },
        ]
      }),
  )

  return (
    <DialogSelect
      title="Usage limits"
      renderFilter={false}
      options={options()}
      preserveSelection
      ref={(value) => {
        selection = value
      }}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.text.subdued}>Connect ChatGPT, Claude Code, or Kiro to view plan usage.</text>
        </box>
      }
      footerHints={[
        { title: "enter", label: "expand/collapse" },
        { title: "r", label: "refresh · cached 1m" },
      ]}
      bindings={[
        { bind: "left", title: "Collapse provider", group: "Usage", run: () => void change(current(), true) },
        { bind: "right", title: "Expand provider", group: "Usage", run: () => void change(current(), false) },
        { bind: "r", title: "Refresh usage", group: "Usage", run: () => void refresh((value) => value + 1) },
      ]}
    />
  )
}
