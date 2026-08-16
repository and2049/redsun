import { createMemo, createSignal } from "solid-js"
import { useSync } from "../context/sync"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import type { RGBA } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"

// REDSUN: toggles for the synthetic per-turn reminder messages appended for
// specific agents (see packages/redsun/src/session/reminders.ts).
const REMINDERS: { value: "plan" | "compose" | "worker" | "build_switch"; title: string; description: string }[] = [
  { value: "plan", title: "plan mode", description: "read-only reminder each plan-agent turn" },
  { value: "compose", title: "compose mode", description: "coordinator brief each compose-agent turn" },
  { value: "worker", title: "worker mode", description: "execution brief each worker-agent turn" },
  { value: "build_switch", title: "build switch", description: "notice on the first build turn after plan mode" },
]

function Status(props: { enabled: boolean; loading: boolean; fg?: RGBA }) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: props.fg ?? theme.textMuted }}>⋯ Saving</span>
  }
  if (props.enabled) {
    return <span style={{ fg: props.fg ?? theme.success }}>✓</span>
  }
  return <span style={{ fg: props.fg ?? theme.textMuted }}>○</span>
}

export function DialogReminders() {
  const dialog = useDialog()
  dialog.setPlacement("bottom")
  const sync = useSync()
  const sdk = useSDK()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)

  const isEnabled = (key: (typeof REMINDERS)[number]["value"]) => sync.data.config.reminders?.[key] !== false

  const options = createMemo(() => {
    const reminders = sync.data.config.reminders
    void reminders
    const current = loading()

    return REMINDERS.map((item) => ({
      value: item.value,
      title: item.title,
      description: item.description,
      footer: (fg?: RGBA) => <Status enabled={isEnabled(item.value)} loading={current === item.value} fg={fg} />,
      category: undefined,
    }))
  })

  const toggle = async (option: DialogSelectOption<string>) => {
    if (loading() !== null) return
    const item = REMINDERS.find((entry) => entry.value === option.value)
    if (!item) return

    setLoading(item.value)
    try {
      await sdk.client.config.update({
        config: { reminders: { [item.value]: !isEnabled(item.value) } },
      })
      const config = await sdk.client.config.get()
      if (config.data) sync.set("config", config.data)
    } catch (error) {
      console.error("Failed to toggle reminder:", error)
    } finally {
      setLoading(null)
    }
  }

  return (
    <DialogSelect
      ref={setRef}
      title="Reminders"
      options={options()}
      onSelect={(option) => {
        // Enter toggles in place; the dialog closes only on escape.
        void toggle(option)
      }}
    />
  )
}
