import { createMemo, createSignal } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "../ui/toast"

function AgentStatus(props: { visible: boolean; loading: boolean }) {
  if (props.loading) {
    return <span>⋯ Loading</span>
  }
  if (props.visible) {
    return <span>✓ Visible</span>
  }
  return <span>○ Hidden</span>
}

const SYSTEM_AGENTS = new Set(["compaction", "title", "summary"])

export function DialogAgentToggle() {
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const dialog = useDialog()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)

  const options = createMemo((): DialogSelectOption<string>[] => {
    const agents = sync.data.agent
    const loadingAgent = loading()
    const userAgents = agents.filter(
      (a) => a.mode !== "subagent" && !SYSTEM_AGENTS.has(a.name),
    )
    const visible = userAgents.filter((a) => !a.hidden)
    const hidden = userAgents.filter((a) => a.hidden)
    return [
      ...visible.map((agent) => ({
        value: agent.name,
        title: agent.name,
        description: agent.native ? "native" : (agent.description || "custom"),
        footer: <AgentStatus visible={true} loading={loadingAgent === agent.name} />,
        disabled: agent.name === "build" || agent.name === "plan",
        category: "Visible",
      })),
      ...hidden.map((agent) => ({
        value: agent.name,
        title: agent.name,
        description: agent.native ? "native" : (agent.description || "custom"),
        footer: <AgentStatus visible={false} loading={loadingAgent === agent.name} />,
        disabled: false,
        category: "Hidden",
      })),
    ]
  })

  const toggle = async (option: DialogSelectOption<string>) => {
    if (option.disabled) {
      toast.show({
        variant: "warning",
        message: `Cannot hide ${option.value} — at least one primary agent must remain visible`,
        duration: 3000,
      })
      return
    }
    if (loading() !== null) return

    const agent = sync.data.agent.find((a) => a.name === option.value)
    if (!agent) return

    const newHidden = !agent.hidden

    const visibleCount = sync.data.agent.filter(
      (a) => a.mode !== "subagent" && !a.hidden,
    ).length
    if (newHidden && visibleCount <= 1) {
      toast.show({
        variant: "warning",
        message: "At least one agent must remain visible",
        duration: 3000,
      })
      return
    }

    setLoading(option.value)
    try {
      await sdk.client.config.update({
        config: {
          agent: {
            [option.value]: {
              hidden: newHidden,
            },
          },
        } as any,
      })
      await sdk.client.instance.dispose()
      const updated = await sdk.client.app.agents({})
      if (updated.data) {
        sync.set("agent", updated.data)
      }
      dialog.replace(() => <DialogAgentToggle />)
      toast.show({
        variant: "info",
        message: `${option.value} ${newHidden ? "hidden" : "visible"}`,
        duration: 2000,
      })
    } catch (error) {
      toast.show({
        variant: "error",
        message: `Failed to toggle ${option.value}`,
        duration: 3000,
      })
    } finally {
      setLoading(null)
    }
  }

  return (
    <DialogSelect
      ref={setRef}
      title="Agents"
      options={options()}
      keybind={[]}
      onSelect={(option) => {
        toggle(option)
      }}
    />
  )
}