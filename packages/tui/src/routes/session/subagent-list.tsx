import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { listWindow } from "./child-navigation"

const AGENT_PATTERN = /^(.*?)\s*\(@([\w-]+) subagent\)$/

function elapsed(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${total % 60}s`
  return `${total}s`
}

export function alignDetails(rows: readonly { elapsed: string; tokens: string }[]) {
  const width = (key: "elapsed" | "tokens") => Math.max(0, ...rows.map((row) => row[key].length))
  const elapsedWidth = width("elapsed")
  const tokensWidth = width("tokens")
  return rows.map((row) => `${row.elapsed.padStart(elapsedWidth)} · ↓ ${row.tokens.padStart(tokensWidth)} tokens`)
}

export const [listHidden, setListHidden] = createSignal(true)

export function SubagentHint(props: { count: number }) {
  const theme = useTheme()
  const shortcuts = Keymap.useShortcuts()
  return (
    <box flexShrink={0} paddingTop={1} paddingLeft={1}>
      <text fg={theme.text.subdued} wrapMode="none">
        <span style={{ fg: theme.text.default }}>{shortcuts.get("session.child.list.next") ?? "down"}</span> view{" "}
        {props.count} subagent{props.count === 1 ? "" : "s"}
      </text>
    </box>
  )
}

export function subagentLabel(title: string | undefined) {
  const match = AGENT_PATTERN.exec(title ?? "")
  return match ? { agent: match[2]!, description: match[1]! } : { agent: "subagent", description: title ?? "" }
}

export function SubagentList(props: {
  root: SessionInfo
  active: readonly SessionInfo[]
  currentID: string
  onSelect: (sessionID: string) => void
}) {
  const data = useData()
  const theme = useTheme()
  const [now, setNow] = createSignal(Date.now())
  const [hover, setHover] = createSignal<string | undefined>()
  createEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const selected = createMemo(() => props.active.findIndex((info) => info.id === props.currentID))
  const window = createMemo(() => listWindow(selected(), props.active.length))
  const visible = createMemo(() => props.active.slice(window().start, window().end))
  const hidden = createMemo(() => props.active.length - window().end)

  const tokens = (sessionID: string) =>
    (data.session.message.list(sessionID) ?? []).reduce(
      (total, message) => total + (message.type === "assistant" ? (message.tokens?.output ?? 0) : 0),
      0,
    )
  const details = createMemo(() =>
    alignDetails(
      visible().map((info) => ({
        elapsed: elapsed(now() - info.time.created),
        tokens: Locale.number(tokens(info.id)),
      })),
    ),
  )

  const Row = (row: { id: string; agent?: string; description: string; detail?: string }) => {
    const current = () => row.id === props.currentID
    return (
      <box
        flexDirection="row"
        justifyContent="space-between"
        gap={2}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={current() || hover() === row.id ? theme.background.surface.offset : undefined}
        onMouseOver={() => setHover(row.id)}
        onMouseOut={() => setHover(undefined)}
        onMouseUp={() => props.onSelect(row.id)}
      >
        <text fg={current() ? theme.text.default : theme.text.subdued} wrapMode="none" truncate flexShrink={1}>
          {current() ? "●" : "○"}{" "}
          <Show when={row.agent}>
            {(agent) => (
              <>
                <span style={{ fg: theme.text.subdued }}>{agent()}</span>
                {"  "}
              </>
            )}
          </Show>
          <b>{row.description}</b>
        </text>
        <Show when={row.detail}>
          {(detail) => (
            <text fg={theme.text.subdued} wrapMode="none" flexShrink={0}>
              {detail()}
            </text>
          )}
        </Show>
      </box>
    )
  }

  return (
    <box flexShrink={0} paddingTop={1}>
      <Row id={props.root.id} description="main" />
      <For each={visible()}>
        {(info, index) => {
          const label = subagentLabel(info.title)
          return <Row id={info.id} agent={label.agent} description={label.description} detail={details()[index()]} />
        }}
      </For>
      <Show when={hidden() > 0}>
        <text fg={theme.text.subdued} paddingLeft={3}>
          {hidden()} more
        </text>
      </Show>
    </box>
  )
}
