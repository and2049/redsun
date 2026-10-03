import type { SessionMessageAssistant } from "@opencode/client"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useConfig } from "../../config"
import { useData } from "../../context/data"
import { useLocal } from "../../context/local"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../i18n"
import { errorMessage } from "../../util/error"
import { AssistantRetry } from "./index"
import { TRANSCRIPT_GUTTER, use } from "./render-context"
import { completionStamp, turnDuration, turnInput, turnTokensPerSecond } from "./rows"

// REDSUN: the assistant footer is redsun's turn-completion line, replacing upstream's
// agent · model · duration footer.

// Turn-completion line, Claude Code style: "▣ Cooked for 35m 43s". The verb is picked
// by message id so it stays put across re-renders instead of reshuffling.
const COMPLETION_VERBS = ["Cooked", "Baked", "Brewed", "Simmered", "Whisked", "Stewed", "Toasted", "Percolated"]

function completionVerb(id: string) {
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) | 0
  return COMPLETION_VERBS[Math.abs(hash) % COMPLETION_VERBS.length]
}

// Whole-second turn clock; hours appear only past the first one.
function completionDuration(ms: number) {
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function AssistantFooter(props: { message: SessionMessageAssistant }) {
  const { t } = useLanguage()
  const ctx = use()
  const config = useConfig()
  const data = useData()
  const local = useLocal()
  const theme = useTheme()
  const interrupted = createMemo(() => props.message.error?.message === "Step interrupted")
  const pinned = () => data.session.pins.list(ctx.sessionID).some((pin) => pin.messageID === props.message.id)
  const messages = createMemo(() => data.session.message.list(ctx.sessionID))
  // The line lives for the whole turn: present tense with a ticking clock while the
  // model works ("Cooking for 12s"), past tense once the turn settles. A step that
  // finished on tool-calls is still mid-turn.
  const generating = createMemo(() => {
    if (props.message.error) return false
    return !(props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish))
  })
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!generating()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })
  const duration = createMemo(() => {
    if (!generating())
      return turnDuration(props.message, messages(), ctx.messageIndex(props.message.id), ctx.legacyTurns())
    const input = turnInput(props.message, messages(), ctx.messageIndex(props.message.id), ctx.legacyTurns())
    return Math.max(0, now() - (input?.time.created ?? props.message.time.created))
  })
  const tokensPerSecond = createMemo(() =>
    turnTokensPerSecond(
      props.message,
      messages(),
      ctx.messageIndex(props.message.id),
      ctx.legacyTurns(),
      generating() ? { now: now() } : undefined,
    ),
  )
  // Seeded by the turn's input so the verb holds steady across the steps of one turn
  // and through the flip from "Cooking" to "Cooked".
  const verb = createMemo(() => {
    const seed = turnInput(props.message, messages())?.id ?? props.message.id
    const past = completionVerb(seed)
    return t(generating() ? past.replace(/ed$/, "ing") : past)
  })
  return (
    <>
      <Show when={props.message.error && !interrupted() && !props.message.retry}>
        <box paddingLeft={TRANSCRIPT_GUTTER}>
          <text fg={theme.text.feedback.error.base}>
            {t("session.error")}: {errorMessage(props.message.error)}
          </text>
        </box>
      </Show>
      <AssistantRetry retry={props.message.retry} />
      <Show when={interrupted()}>
        <box paddingLeft={TRANSCRIPT_GUTTER} marginTop={props.message.retry ? 1 : 0}>
          <text fg={theme.text.muted}>{t("session.interrupted")}</text>
        </box>
      </Show>
      <Show when={!props.message.error && (generating() || duration() > 0)}>
        <box paddingLeft={TRANSCRIPT_GUTTER}>
          {/* U+25A3 keeps text presentation everywhere; U+2733 turns emoji on Windows.
              The icon carries the agent's color as a finished-in-this-mode indicator. */}
          <text>
            <span style={{ fg: local.agent.color(props.message.agent) }}>▣ </span>
            <Show
              when={generating()}
              fallback={
                <>
                  <span style={{ fg: theme.text.muted }}>
                    {t("session.for", { verb: verb(), duration: completionDuration(duration()) })}
                  </span>
                  <Show when={config.data.session.tps && tokensPerSecond()}>
                    {(value) => (
                      <span style={{ fg: theme.text.muted }}> · {t("ai.tokS", { rate: value().toFixed(1) })}</span>
                    )}
                  </Show>
                  <Show when={props.message.time.completed}>
                    {(completed) => (
                      <span style={{ fg: theme.text.muted }}>
                        {" "}
                        · {t("session.done", { time: completionStamp(completed(), Date.now()) })}
                      </span>
                    )}
                  </Show>
                  <Show when={pinned()}>
                    <span style={{ fg: theme.text.muted }}> · {t("pins.pinned")}</span>
                  </Show>
                </>
              }
            >
              <span style={{ fg: theme.text.muted }}>
                {verb()}… ({completionDuration(duration())}
                {config.data.session.tps && tokensPerSecond()
                  ? ` · ${t("ai.tokS", { rate: tokensPerSecond()?.toFixed(1) ?? "" })}`
                  : ""}
                )
              </span>
            </Show>
          </text>
        </box>
      </Show>
    </>
  )
}
