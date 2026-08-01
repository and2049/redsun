// One-row subagent strip, shown in the dock while a child session is open.
//
// The dense equivalent of routes/session/subagent-footer.tsx: same label,
// position and usage readout, but a single dim row with keyboard hints instead
// of a bordered panel with mouse targets (dense runs without mouse capture).
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { createMemo, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useCommandShortcut } from "../../keymap"
import { Locale } from "../../util/locale"

export function SubagentStrip() {
  const route = useRouteData("session")
  const sync = useSync()
  const { theme } = useTheme()
  const parentShortcut = useCommandShortcut("session.parent")
  const previousShortcut = useCommandShortcut("session.child.previous")
  const nextShortcut = useCommandShortcut("session.child.next")

  const session = createMemo(() => sync.session.get(route.sessionID))

  const info = createMemo(() => {
    const current = session()
    if (!current) return { label: "Subagent", index: 0, total: 0 }
    const agent = current.title.match(/@(\w+) subagent/)
    const label = agent ? Locale.titlecase(agent[1]) : "Subagent"
    if (!current.parentID) return { label, index: 0, total: 0 }

    const siblings = sync.data.session
      .filter((x) => x.parentID === current.parentID)
      .toSorted((a, b) => a.time.created - b.time.created)
    return { label, index: siblings.findIndex((x) => x.id === current.id) + 1, total: siblings.length }
  })

  const usage = createMemo(() => {
    const messages = sync.data.message[route.sessionID] ?? []
    const last = messages.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
    )
    if (!last) return
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = session()?.cost ?? 0
    const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
    return [pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens), cost > 0 ? money.format(cost) : undefined]
      .filter(Boolean)
      .join(" · ")
  })

  const hints = createMemo(() =>
    [
      parentShortcut() ? `${parentShortcut()} parent` : undefined,
      previousShortcut() ? `${previousShortcut()} prev` : undefined,
      nextShortcut() ? `${nextShortcut()} next` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  )

  return (
    <box height={1} flexDirection="row" gap={1} flexShrink={0}>
      <text fg={theme.secondary} wrapMode="none" truncate>
        ⌁ {info().label}
        <Show when={info().total > 0}>
          <span style={{ fg: theme.textMuted }}>
            {" "}
            ({info().index} of {info().total})
          </span>
        </Show>
        <Show when={usage()}>
          <span style={{ fg: theme.textMuted }}> · {usage()}</span>
        </Show>
        <Show when={hints()}>
          <span style={{ fg: theme.textMuted }}> · {hints()}</span>
        </Show>
      </text>
    </box>
  )
}
