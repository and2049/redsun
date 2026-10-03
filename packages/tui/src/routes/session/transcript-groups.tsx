import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import type { MouseEvent } from "@opentui/core"
import { useRenderer, type JSX } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { reasoningSummary } from "../../context/thinking"
import { useTheme } from "../../context/theme"
import { useLanguage } from "../../i18n"
import { toolDisplay } from "./index"
import { Disclosure, InlineToolRow, reasoningContent } from "./message-parts"
import { use } from "./render-context"
import { explorationSummary, resolvePart, type PartRef } from "./rows"

// REDSUN: collapsed transcript groups. Consecutive reasoning folds into one "Thinking"
// disclosure; consecutive exploration tools fold into one summary row. The session route
// passes in how to render the parts a group expands to.

export function SessionReasoningGroupView(props: {
  refs: PartRef[]
  completed: boolean
  message: (messageID: string) => SessionMessageInfo | undefined
  part: (ref: PartRef) => JSX.Element
}) {
  const { t } = useLanguage()
  const ctx = use()
  const [expanded, setExpanded] = createSignal(false)
  const parts = createMemo(() =>
    props.refs.flatMap((ref) => {
      const message = props.message(ref.messageID)
      if (message?.type !== "assistant") return []
      const part = resolvePart(message, ref.partID)
      if (part?.type !== "reasoning" || !reasoningContent(part)) return []
      return [{ message, part }]
    }),
  )
  const content = createMemo(() =>
    parts()
      .map((item) => reasoningContent(item.part))
      .join("\n\n"),
  )
  const latest = createMemo((previous: string | null) => {
    const item = parts().at(-1)
    if (!item) return previous
    const title = reasoningSummary(reasoningContent(item.part)).title
    if (title) return title
    if (item.part.time?.completed !== undefined || item.message.time.completed !== undefined) return null
    return previous
  }, null)

  return (
    <Show when={parts().length > 0}>
      <Show when={ctx.thinkingMode() === "hide"} fallback={<For each={props.refs}>{(ref) => props.part(ref)}</For>}>
        <Disclosure
          label={t("application.thinking")}
          italic
          content={content()}
          title={latest()}
          done={props.completed}
          toggleable={true}
          open={expanded()}
          onToggle={() => setExpanded((value) => !value)}
        />
      </Show>
    </Show>
  )
}

export function SessionGroupView(props: {
  refs: PartRef[]
  pending: PartRef[]
  completed: boolean
  message: (messageID: string) => SessionMessageInfo | undefined
  tool: (part: SessionMessageAssistantTool, images?: boolean) => JSX.Element
  images: (parts: SessionMessageAssistantTool[]) => JSX.Element
}) {
  const theme = useTheme()
  const ctx = use()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)
  const parts = (refs: PartRef[]) =>
    refs.flatMap((ref) => {
      const message = props.message(ref.messageID)
      if (message?.type !== "assistant") return []
      const part = resolvePart(message, ref.partID)
      if (part?.type !== "tool") return []
      return [part]
    })
  const grouped = createMemo(() => parts(props.refs))
  const pending = createMemo(() => parts(props.pending))
  const completed = createMemo(
    () => props.completed || (grouped().length > 0 && grouped().every((part) => part.time.completed !== undefined)),
  )
  const label = createMemo(() => explorationSummary(grouped().map((part) => toolDisplay(part.name))))
  return (
    <Show when={grouped().length > 0 || pending().length > 0}>
      <Show
        when={ctx.groupExploration()}
        fallback={<For each={[...grouped(), ...pending()]}>{(part) => props.tool(part)}</For>}
      >
        <Show when={grouped().length > 0}>
          <InlineToolRow
            icon={expanded() ? "−" : "✱"}
            iconColor={theme.accent}
            color={hover() ? theme.text.base : theme.text.muted}
            complete={completed()}
            pending={label()}
            spinner={!completed()}
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={(event: MouseEvent) => {
              if (event.button !== 0 || renderer.getSelection()?.getSelectedText()) return
              setExpanded((value) => !value)
            }}
          >
            <span style={{ fg: theme.accent, bold: true }}>{label()}</span>
            {expanded() ? "" : " (click to expand)"}
          </InlineToolRow>
        </Show>
        <Show when={expanded() && grouped().length > 0}>
          <For each={grouped()}>{(part) => props.tool(part, false)}</For>
        </Show>
        {props.images(grouped())}
        <For each={pending()}>{(part) => props.tool(part)}</For>
      </Show>
    </Show>
  )
}
