import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { usePathFormatter } from "../../context/path-format"
import { useTheme, useThemes } from "../../context/theme"
import { useLanguage } from "../../i18n"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { flattenTodos, todoItems, type TodoItem } from "../../util/tool-display"
import { BlockTool, InlineTool, type ToolProps } from "./index"
import { INLINE_TOOL_ICON_WIDTH } from "./message-parts"
import { TRANSCRIPT_GUTTER, use } from "./render-context"

// REDSUN: transcript views for redsun's own tools (todowrite, plan_exit).

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

const TODO_GLYPHS: Record<string, string> = {
  pending: "◻",
  in_progress: "◐",
  completed: "◼",
  cancelled: "✗",
}

function TodoLine(props: { todo: TodoItem; depth: number }) {
  const theme = useTheme()
  const color = () => {
    if (props.todo.status === "in_progress") return theme.accent
    if (props.todo.status === "completed" || props.todo.status === "cancelled") return theme.text.muted
    return theme.text.base
  }
  return (
    <>
      <text fg={color()} attributes={props.todo.status === "cancelled" ? TextAttributes.STRIKETHROUGH : undefined}>
        {"  ".repeat(props.depth)}
        {TODO_GLYPHS[props.todo.status] ?? "◻"} {props.todo.content}
      </text>
      <For each={props.todo.children}>{(child) => <TodoLine todo={child} depth={props.depth + 1} />}</For>
    </>
  )
}

export function TodoWrite(props: ToolProps) {
  const { t } = useLanguage()
  // Both writers land here: redsun's todowrite metadata and Claude Code's mirrored
  // TodoWrite input. Fall back to the call input while the result is streaming.
  const todos = createMemo(() => {
    const fromMetadata = todoItems(props.metadata.todos)
    return fromMetadata.length > 0 ? fromMetadata : todoItems(props.input.todos)
  })
  const all = createMemo(() => flattenTodos(todos()))
  const open = createMemo(
    () => all().filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length,
  )
  const [expanded, setExpanded] = createSignal(true)
  return (
    <>
      <InlineTool
        icon="☰"
        name="Tasks"
        pending={t("tools.updatingTasks")}
        complete={all().length > 0}
        part={props.part}
        onClick={() => setExpanded((value) => !value)}
      >
        {all().length} task{all().length === 1 ? "" : "s"} ({open()} open)
      </InlineTool>
      <Show when={expanded() && todos().length > 0}>
        <box paddingLeft={TRANSCRIPT_GUTTER + INLINE_TOOL_ICON_WIDTH}>
          <For each={todos()}>{(todo) => <TodoLine todo={todo} depth={0} />}</For>
        </box>
      </Show>
    </>
  )
}

const PLAN_BLOCK_ROWS = 10

export function PlanExit(props: ToolProps) {
  const { t } = useLanguage()
  const ctx = use()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const pathFormatter = usePathFormatter()
  const info = createMemo(() => parsePlanExit(props.metadata))
  const [expanded, setExpanded] = createSignal(false)
  const plan = createMemo(() => info().plan?.trim() ?? "")
  const collapsed = createMemo(() =>
    collapseToolOutput(plan(), PLAN_BLOCK_ROWS, PLAN_BLOCK_ROWS * Math.max(20, ctx.width - 4)),
  )
  const remaining = createMemo(() => Math.max(0, plan().split("\n").length - PLAN_BLOCK_ROWS))
  const outcomeColor = createMemo(() => {
    const kind = info().outcome?.kind
    if (kind === "approved") return theme.text.feedback.success.base
    if (kind === "declined") return theme.text.feedback.warning.base
    return theme.text.feedback.error.base
  })

  return (
    <Switch>
      <Match when={plan() || info().outcome}>
        <BlockTool
          title={info().filePath ? undefined : "# Plan"}
          path={info().filePath ? { label: "# Plan", value: pathFormatter.format(info().filePath) } : undefined}
          part={props.part}
          onClick={collapsed().overflow ? () => setExpanded((value) => !value) : undefined}
        >
          <Show when={plan()}>
            <code
              conceal={false}
              fg={theme.text.base}
              filetype="markdown"
              syntaxStyle={syntax()}
              content={expanded() || !collapsed().overflow ? plan() : collapsed().output}
            />
            <Show when={collapsed().overflow}>
              <text fg={theme.text.muted}>
                {expanded()
                  ? t("tools.clickToCollapse")
                  : remaining() > 0
                    ? t("tools.shell.expandLines", { count: remaining() })
                    : t("tools.clickToExpand")}
              </text>
            </Show>
          </Show>
          <Show when={info().outcome}>{(outcome) => <text fg={outcomeColor()}>{outcome().text}</text>}</Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="→"
          name="Plan"
          pending="Presenting plan…"
          complete={props.part.state.status === "completed"}
          part={props.part}
        >
          {props.output?.trim().split("\n")[0] ?? ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

export type PlanExitOutcome = { kind: "approved" | "declined" | "failed"; text: string }

/** A `plan_exit` row: `{plan?, filePath?, approved?, feedback?, error?}` metadata. */
export function parsePlanExit(metadata: Record<string, unknown>) {
  const feedback = stringValue(metadata.feedback)?.trim()
  const error = stringValue(metadata.error)?.trim()
  // A decline outranks the error the CLI reports for it; an error after approval means the native
  // exit failed, so the session stayed in plan mode and the row shows the failure.
  const outcome: PlanExitOutcome | undefined =
    metadata.approved === false
      ? { kind: "declined", text: feedback ? `declined: ${feedback}` : "declined" }
      : error
        ? { kind: "failed", text: `failed: ${error}` }
        : metadata.approved === true
          ? { kind: "approved", text: "approved" }
          : undefined
  return { plan: stringValue(metadata.plan), filePath: stringValue(metadata.filePath), outcome }
}
