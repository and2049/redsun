import { createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
} from "@opencode/client"
import { Spinner } from "../../component/spinner"
import { useTheme, useThemes } from "../../context/theme"
import { reasoningSummary } from "../../context/thinking"
import { usePlugin } from "../../plugin/context"
import { TRANSCRIPT_GUTTER, use } from "./render-context"

import { useLanguage } from "../../i18n"
import { useRenderer } from "@opentui/solid"
import { stringWidth } from "../../util/string-width"

export const INLINE_TOOL_ICON_WIDTH = 2

export function ReasoningPart(props: {
  last: boolean
  part: SessionMessageAssistantReasoning
  message: SessionMessageAssistant
}) {
  const { t } = useLanguage()
  const ctx = use()
  // Collapsed by default in hide mode: a single line throughout, so the layout
  // never shifts. Click to open the full trace, click to close.
  const [expanded, setExpanded] = createSignal(false)

  const content = createMemo(() => reasoningContent(props.part))
  const isDone = createMemo(
    () => props.part.time?.completed !== undefined || props.message.time.completed !== undefined,
  )
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const summary = createMemo(() => reasoningSummary(content()))

  return (
    <Show when={content()}>
      <Disclosure
        label={t("application.thinking")}
        italic
        content={content()}
        title={summary().title}
        done={isDone()}
        toggleable={inMinimal()}
        open={!inMinimal() || expanded()}
        onToggle={() => setExpanded((prev) => !prev)}
      />
    </Show>
  )
}

export function reasoningContent(part: SessionMessageAssistantReasoning) {
  // OpenRouter encrypts some reasoning blocks; drop the placeholder.
  return part.text.replace("[REDACTED]", "").trim()
}

export function TextPart(props: {
  last: boolean
  part: SessionMessageAssistantText
  message: SessionMessageAssistant
}) {
  const ctx = use()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const plugins = usePlugin()
  return (
    <Show when={props.part.text.trim()}>
      <box paddingLeft={TRANSCRIPT_GUTTER} flexShrink={0}>
        {/* Apply content before streaming so completion does not freeze the previous Markdown tokens. */}
        <markdown
          syntaxStyle={syntax()}
          renderNode={plugins.markdown()}
          content={props.part.text.trim()}
          streaming={props.message.time.completed === undefined}
          internalBlockMode="top-level"
          tableOptions={{ style: "grid", cellPaddingX: 1 }}
          conceal={ctx.markdownMode() === "rendered"}
          fg={theme.markdown.text}
          bg={theme.background.default}
        />
      </box>
    </Show>
  )
}

export function InlineToolRow(props: {
  icon: string
  iconColor?: RGBA
  name?: string
  nameColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  status?: JSX.Element
  children: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
}) {
  return (
    <box
      paddingLeft={TRANSCRIPT_GUTTER}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
    >
      <Switch>
        <Match when={props.spinner}>
          <Show
            when={props.status}
            fallback={
              <Spinner color={props.color}>
                <ToolName name={props.name} color={props.nameColor ?? props.color} />
                {props.children}
              </Spinner>
            }
          >
            {(status) => (
              <box flexDirection="row" gap={1}>
                <Spinner color={props.color} />
                <InlineToolLabel color={props.color} name={props.name} nameColor={props.nameColor} status={status()}>
                  {props.children}
                </InlineToolLabel>
              </box>
            )}
          </Show>
        </Match>
        <Match when={true}>
          <Show fallback={<Spinner color={props.color}>{props.pending}</Spinner>} when={props.complete || props.failed}>
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <Show
                when={props.status}
                fallback={
                  <text
                    flexGrow={1}
                    fg={props.failed ? props.errorColor : props.color}
                    attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
                  >
                    <ToolName
                      name={props.name}
                      color={props.failed ? props.errorColor : (props.nameColor ?? props.color)}
                    />
                    {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
                  </text>
                }
              >
                {(status) => (
                  <InlineToolLabel
                    color={props.failed ? props.errorColor : props.color}
                    name={props.name}
                    nameColor={props.failed ? props.errorColor : props.nameColor}
                    denied={props.denied}
                    status={status()}
                  >
                    {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
                  </InlineToolLabel>
                )}
              </Show>
            </box>
          </Show>
        </Match>
      </Switch>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

function InlineToolLabel(props: {
  color?: RGBA
  name?: string
  nameColor?: RGBA
  denied?: boolean
  status: JSX.Element
  children: JSX.Element
}) {
  return (
    <box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1}>
      <text
        maxWidth="100%"
        flexShrink={0}
        fg={props.color}
        attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
      >
        <ToolName name={props.name} color={props.nameColor ?? props.color} />
        {props.children}
      </text>
      {props.status}
    </box>
  )
}

// The tool name that leads an inline row, in bold accent: the row reads as
// `Name args` with only the name coloured, so it registers as a call rather
// than another line of muted prose.
function ToolName(props: { name?: string; color?: RGBA }) {
  return (
    <Show when={props.name}>
      <span style={{ fg: props.color, bold: true }}>{props.name}</span>{" "}
    </Show>
  )
}

const THINKING_LABEL = "▶ Thinking: "

// The collapsed disclosure row shows the *end* of the content, not its start:
// what the model concluded is more useful at a glance than how it opened. Sized
// so the row never wraps -- the chevron, the label and the gutters come off the
// available width before the tail is taken.
export function thinkingTeaser(content: string, width: number, label = THINKING_LABEL) {
  const available = Math.max(10, width - 3 - stringWidth(label) - 4)
  const flat = content.replace(/\s+/g, " ").trim()
  if (flat.length <= available) return flat
  return "..." + flat.slice(flat.length - available)
}

// A pre-collapsed disclosure: a single "▶ Label: …tail" line that clicking flips
// to "▼ Label:" with the full content indented flush beneath it. The show mode
// (`session.toggle.thinking`) renders the same look pinned open. Muted
// throughout -- reasoning traces and compaction summaries are asides, and
// colouring them competes with the tool rows for attention. Thinking renders
// italic; compaction reuses the identical shape without the italic flag.
export function Disclosure(props: {
  label: string
  title: string | null
  content: string
  done: boolean
  toggleable: boolean
  open: boolean
  onToggle: () => void
  italic?: boolean
  color?: string | RGBA | undefined
}) {
  const ctx = use()
  const theme = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const collapsedLabel = () => `▶ ${props.label}: `
  const teaser = createMemo(() => thinkingTeaser(props.content, ctx.width, collapsedLabel()))
  const color = () => props.color ?? theme.text.subdued
  const attributes = () => (props.italic ? TextAttributes.ITALIC : undefined)

  return (
    <box paddingLeft={TRANSCRIPT_GUTTER} paddingRight={TRANSCRIPT_GUTTER} flexDirection="column" flexShrink={0}>
      <Show
        when={props.done}
        fallback={
          <box flexDirection="row">
            <Spinner color={theme.text.feedback.warning.default}>
              {props.title ? `${props.label}: ${props.title}` : props.label}
            </Spinner>
          </box>
        }
      >
        <box
          onMouseOver={() => props.toggleable && setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => {
            if (!props.toggleable) return
            if (renderer.getSelection()?.getSelectedText()) return
            props.onToggle()
          }}
        >
          <text fg={hover() ? theme.text.default : color()} wrapMode="none" attributes={attributes()}>
            {props.open ? `▼ ${props.label}:` : collapsedLabel() + teaser()}
          </text>
        </box>
      </Show>
      <Show when={props.open && props.content}>
        <box paddingLeft={2}>
          <text fg={color()} attributes={attributes()}>
            {props.content}
          </text>
        </box>
      </Show>
    </box>
  )
}
