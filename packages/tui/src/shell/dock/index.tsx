// The pinned bottom dock of the dense session view.
//
// Stack (top→bottom): live-tail preview of in-flight work (running tools and
// the streaming text tail — committed to scrollback only once final), a
// fixed-height status row (anti-jitter), a single-line toast notice, the
// active view (inline dialog / permission / question / prompt), and a two-line
// dim footer. DenseApp renders the vim `:` bar below as the last footer row.
//
// View precedence is dialog → permission → question → prompt: a permission or
// question arriving while a picker is open queues behind it and appears when
// the picker closes, rather than yanking the view out from under the user.
//
// The dock owns the footer-region height policy (see height.ts) because it is
// the only place that can see every input to it.
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, For, Match, Show, Switch } from "solid-js"
import { Prompt, type PromptRef } from "../../component/prompt"
import { Spinner } from "../../component/spinner"
import { useDirectory } from "../../context/directory"
import { useLocal } from "../../context/local"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { useVim } from "../../context/vim"
import { usePluginRuntime } from "../../plugin/runtime"
import { PermissionPrompt } from "../../routes/session/permission"
import { QuestionPrompt } from "../../routes/session/question"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { isDefaultTitle } from "../../util/session"
import * as Locale from "../../util/locale"
import { applyFooterHeight } from "../boot"
import { pendingAssistantID } from "../transcript/blocks"
import { dockRows, type DockView } from "./height"
import { inlineSelectRows } from "./inline-select"
import { Notice } from "./notice"

export { DOCK_ROWS, DOCK_TALL_ROWS, dockRows } from "./height"

export function Dock(props: {
  sessionID: string
  bind: (ref: PromptRef | undefined) => void
  visible: boolean
  disabled: boolean
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}) {
  const sync = useSync()
  const local = useLocal()
  const vim = useVim()
  const dialog = useDialog()
  const toast = useToast()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const directory = useDirectory()
  const pluginRuntime = usePluginRuntime()

  const status = createMemo(() => sync.data.session_status[props.sessionID])
  const goal = createMemo(() => sync.data.session_goal[props.sessionID]?.condition)
  const session = createMemo(() => sync.session.get(props.sessionID))
  const title = createMemo(() => {
    const value = session()?.title
    if (!value || isDefaultTitle(value)) return undefined
    return Locale.truncate(value, 40)
  })
  const branch = createMemo(() => sync.data.vcs?.branch)
  const model = createMemo(() => local.model.current())
  const agent = createMemo(() => local.agent.current()?.name)
  // Temporary normal mode (ctrl+x) counts down in place of the plain label.
  const vimMode = createMemo(() =>
    vim.tempRemaining() != null ? `<NORMAL ${vim.tempRemaining()}s>` : `<${vim.mode.toUpperCase()}>`,
  )

  const view = createMemo<DockView>(() => {
    if (dialog.stack.length > 0) return "dialog"
    if (props.permissions.length > 0) return "permission"
    if (props.questions.length > 0) return "question"
    return "prompt"
  })

  // Bounded preview of uncommitted in-flight work: running tools plus the
  // last line of streaming text/reasoning. The transcript committer only
  // writes settled blocks, so this is the sole live view of the tail.
  const tail = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    const pending = pendingAssistantID(messages)
    if (!pending) return []
    const parts = sync.data.part[pending] ?? []
    const lines: string[] = []
    for (const part of parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "running" && part.state.status !== "pending") continue
      const title = part.state.status === "running" ? part.state.title : undefined
      lines.push(`⏺ ${Locale.titlecase(part.tool)}${title ? `(${title})` : ""}…`)
    }
    const last = parts.at(-1)
    if (last?.type === "text" && last.time?.end === undefined) {
      const line = last.text.trimEnd().split("\n").at(-1)?.trim()
      if (line) lines.push(line)
    } else if (last?.type === "reasoning" && last.time.end === undefined) {
      lines.push("✳ thinking…")
    }
    return lines.slice(-3)
  })

  const notice = createMemo(() => Boolean(toast.currentToast))

  createEffect(() => {
    applyFooterHeight(
      renderer,
      dockRows({
        view: view(),
        viewport: renderer.terminalHeight,
        tail: tail().length,
        notice: notice(),
        selectRows: inlineSelectRows(),
        commandBar: vim.mode === "command",
      }),
    )
  })

  return (
    <box flexDirection="column" width="100%" flexShrink={0}>
      <For each={tail()}>
        {(line) => (
          <box height={1} flexDirection="row">
            <text fg={theme.textMuted} wrapMode="none" truncate>
              {line}
            </text>
          </box>
        )}
      </For>
      <box height={1} flexDirection="row" gap={1}>
        <Show
          when={status()?.type === "busy" || status()?.type === "retry"}
          fallback={<text fg={theme.textMuted}> </text>}
        >
          <Spinner color={theme.secondary} />
          <text fg={theme.textMuted} wrapMode="none" truncate>
            {status()?.type === "retry" ? "retrying…" : "working…"}
            <span style={{ fg: theme.textMuted }}> (esc to interrupt)</span>
          </text>
        </Show>
        <Show when={goal()}>
          <text fg={theme.warning} wrapMode="none" truncate>
            ◎ {goal()}
          </text>
        </Show>
      </box>
      <Notice width={dimensions().width} />
      <Switch>
        <Match when={view() === "dialog"}>
          <box flexDirection="column" flexShrink={0}>
            {dialog.stack.at(-1)!.element}
          </box>
        </Match>
        <Match when={view() === "permission"}>
          <PermissionPrompt
            request={props.permissions[0]}
            directory={sync.session.get(props.permissions[0].sessionID)?.directory}
          />
        </Match>
        <Match when={view() === "question"}>
          <QuestionPrompt
            request={props.questions[0]}
            directory={sync.session.get(props.questions[0].sessionID)?.directory}
          />
        </Match>
        <Match when={props.visible}>
          <pluginRuntime.Slot
            name="session_prompt"
            mode="replace"
            session_id={props.sessionID}
            visible={props.visible}
            disabled={props.disabled}
            ref={props.bind}
          >
            <Prompt
              visible={props.visible}
              ref={props.bind}
              disabled={props.disabled}
              sessionID={props.sessionID}
              right={<pluginRuntime.Slot name="session_prompt_right" session_id={props.sessionID} />}
            />
          </pluginRuntime.Slot>
        </Match>
      </Switch>
      <box height={1} flexDirection="row" gap={1}>
        <text fg={theme.textMuted} wrapMode="none" truncate>
          {directory()}
          {branch() ? ` (${branch()})` : ""}
          {title() ? ` · ${title()}` : ""}
        </text>
      </box>
      <box height={1} flexDirection="row" gap={1}>
        <text fg={theme.textMuted} wrapMode="none" truncate>
          {vimMode()} {agent() ? `${agent()} · ` : ""}
          {model() ? `${model()!.providerID}/${model()!.modelID}` : "no model"}
        </text>
      </box>
    </box>
  )
}
