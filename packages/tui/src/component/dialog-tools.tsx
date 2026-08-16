import { createMemo, createSignal } from "solid-js"
import { useSync } from "../context/sync"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import type { RGBA } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"

// REDSUN: user-facing tool enable/disable. Rows mirror the builtin registry;
// the edit family (edit/write/apply_patch collapse to the `edit` permission,
// plus multiedit which wraps the edit tool) and the web-search pair
// (websearch/codesearch) toggle together because the permission layer cannot
// split them.
const TOOL_GROUPS: {
  value: string
  title: string
  description: string
  keys: string[]
  warn?: boolean
}[] = [
  { value: "bash", title: "bash", description: "run shell commands", keys: ["bash"], warn: true },
  { value: "read", title: "read", description: "read files", keys: ["read"], warn: true },
  { value: "glob", title: "glob", description: "find files by pattern", keys: ["glob"] },
  { value: "grep", title: "grep", description: "search file contents", keys: ["grep"] },
  {
    value: "edit",
    title: "file edits",
    description: "edit, write, patch, multiedit",
    keys: ["edit", "multiedit"],
  },
  { value: "task", title: "task", description: "delegate to subagents", keys: ["task"] },
  { value: "todowrite", title: "todowrite", description: "task checklist", keys: ["todowrite"] },
  { value: "webfetch", title: "webfetch", description: "fetch URLs", keys: ["webfetch"] },
  {
    value: "websearch",
    title: "web search",
    description: "websearch, codesearch",
    keys: ["websearch", "codesearch"],
  },
  { value: "skill", title: "skill", description: "load skills", keys: ["skill"] },
  { value: "list", title: "list", description: "list directory trees", keys: ["list"] },
  { value: "project", title: "project", description: "run project commands", keys: ["project"] },
  { value: "reload", title: "reload", description: "reload extensions", keys: ["reload"] },
  { value: "question", title: "question", description: "ask the user questions", keys: ["question"] },
]

function Status(props: { enabled: boolean; loading: boolean; warn?: boolean; fg?: RGBA }) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: props.fg ?? theme.textMuted }}>⋯ Saving</span>
  }
  if (props.enabled) {
    return <span style={{ fg: props.fg ?? theme.success }}>✓</span>
  }
  if (props.warn) {
    return <span style={{ fg: props.fg ?? theme.warning }}>○</span>
  }
  return <span style={{ fg: props.fg ?? theme.textMuted }}>○</span>
}

export function DialogTools() {
  const dialog = useDialog()
  dialog.setPlacement("bottom")
  const sync = useSync()
  const sdk = useSDK()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)

  const isEnabled = (keys: string[]) => keys.every((key) => sync.data.config.tools?.[key] !== false)

  const options = createMemo(() => {
    // Track config and loading state to re-render on change
    const tools = sync.data.config.tools
    void tools
    const current = loading()

    return TOOL_GROUPS.map((group) => ({
      value: group.value,
      title: group.title,
      description: group.description,
      footer: (fg?: RGBA) => <Status enabled={isEnabled(group.keys)} loading={current === group.value} warn={group.warn} fg={fg} />,
      category: undefined,
    }))
  })

  const toggle = async (option: DialogSelectOption<string>) => {
    if (loading() !== null) return
    const group = TOOL_GROUPS.find((item) => item.value === option.value)
    if (!group) return

    setLoading(group.value)
    try {
      const next = !isEnabled(group.keys)
      await sdk.client.config.update({
        config: { tools: Object.fromEntries(group.keys.map((key) => [key, next])) },
      })
      const config = await sdk.client.config.get()
      if (config.data) sync.set("config", config.data)
    } catch (error) {
      console.error("Failed to toggle tool:", error)
    } finally {
      setLoading(null)
    }
  }

  return (
    <DialogSelect
      ref={setRef}
      title="Tools"
      options={options()}
      onSelect={(option) => {
        // Enter toggles in place; the dialog closes only on escape.
        void toggle(option)
      }}
    />
  )
}
