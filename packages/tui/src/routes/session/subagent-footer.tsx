// REDSUN DENSE: the dock of a child session.
//
// A child session is a read-only view of a subagent, so its dock carries this
// row where the parent carries the prompt: which subagent this is, where it sits
// among its siblings, what it has spent, and the three ways back out. The label
// is parsed from the title the Claude Code mirror and the native subagent tool
// both write — `<description> (@<agent> subagent)`.
import { createMemo, createSignal, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { SessionMessageAssistant } from "@opencode-ai/client/promise"
import { useData } from "../../context/data"
import { Keymap } from "../../context/keymap"
import { useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"

const AGENT_PATTERN = /@([\w-]+) subagent/

const ACTIONS = [
  { key: "parent", label: "Parent", command: "session.parent" },
  { key: "previous", label: "Prev", command: "session.child.previous" },
  { key: "next", label: "Next", command: "session.child.next" },
] as const

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export function SubagentFooter() {
  const route = useRouteData("session")
  const data = useData()
  const theme = useTheme()
  const keymap = Keymap.use()
  const shortcuts = Keymap.useShortcuts()
  const [hover, setHover] = createSignal<string | undefined>()
  // Re-measure on resize so the row reflows with the dock.
  useTerminalDimensions()

  const session = createMemo(() => data.session.get(route.sessionID))

  const position = createMemo(() => {
    const current = session()
    if (!current) return { label: "Subagent", index: 0, total: 0 }
    const label = Locale.titlecase(AGENT_PATTERN.exec(current.title ?? "")?.[1] ?? "subagent")
    if (!current.parentID) return { label, index: 0, total: 0 }
    const siblings = data.session
      .family(current.id)
      .flatMap((sessionID) => {
        const info = data.session.get(sessionID)
        return info && info.parentID === current.parentID ? [info] : []
      })
      .toSorted((a, b) => a.time.created - b.time.created)
    return { label, index: siblings.findIndex((info) => info.id === current.id) + 1, total: siblings.length }
  })

  const usage = createMemo(() => {
    const cost = session()?.cost ?? 0
    const messages = data.session.message.list(route.sessionID) ?? []
    const last = messages.findLast(
      (message): message is SessionMessageAssistant =>
        message.type === "assistant" && (message.tokens?.output ?? 0) > 0,
    )
    const tokens = last?.tokens
      ? last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
      : 0
    if (tokens <= 0 && cost <= 0) return undefined
    const limit = last
      ? data.location.model
          .list(session()?.location)
          ?.find((model) => model.providerID === last.model.providerID && model.id === last.model.id)?.limit.context
      : undefined
    const percent = limit ? ` (${Math.round((tokens / limit) * 100)}%)` : ""
    return {
      context: tokens > 0 ? `${Locale.number(tokens)}${percent}` : undefined,
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  return (
    <box flexShrink={0}>
      {/* The dense dock draws its rows in the prompt box's rounded shape, and
          like the prompt it takes no fill: a terminal cell cannot clip, so a
          background would paint square corners behind the rounded border. */}
      <box border borderStyle="rounded" borderColor={theme.border.default} paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text.default}>
              <b>{position().label}</b>
            </text>
            <Show when={position().total > 0}>
              <text fg={theme.text.subdued}>
                ({position().index} of {position().total})
              </text>
            </Show>
            <Show when={usage()}>
              {(item) => (
                <text fg={theme.text.subdued} wrapMode="none">
                  {[item().context, item().cost].filter(Boolean).join(" · ")}
                </text>
              )}
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <For each={ACTIONS}>
              {(action) => (
                <box
                  onMouseOver={() => setHover(action.key)}
                  onMouseOut={() => setHover(undefined)}
                  onMouseUp={() => keymap.dispatch(action.command)}
                  backgroundColor={hover() === action.key ? theme.background.surface.offset : undefined}
                >
                  <text fg={theme.text.default}>
                    {action.label} <span style={{ fg: theme.text.subdued }}>{shortcuts.get(action.command)}</span>
                  </text>
                </box>
              )}
            </For>
          </box>
        </box>
      </box>
    </box>
  )
}
