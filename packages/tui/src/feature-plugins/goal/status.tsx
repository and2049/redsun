import { Plugin } from "@opencode-ai/plugin/tui"
import { createMemo, Show } from "solid-js"
import { formatGoalBudget, type GoalBudget } from "../../util/goal"

// Message-metadata contract with the redsun goal plugin (core/src/plugin/redsun/goal.ts).
const GOAL_METADATA_KEY = "redsun.goal"
const GOAL_BUDGET_KEY = "redsun.goal.budget"
const GOAL_CLEAR = "__clear__"

/**
 * REDSUN: active-goal chip above the prompt (v1 placement). Derived straight from message
 * metadata — the newest user/synthetic directive wins, so the chip updates the moment the
 * /goal prompt or a plugin-authored clear synthetic lands, with no extra API surface.
 * Delegated Claude Code sessions never receive the metadata, so the chip stays hidden.
 */
export function GoalStatus(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const goal = createMemo(() => {
    const messages = props.context.data.session.message.list(props.sessionID)
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (!message || (message.type !== "user" && message.type !== "synthetic")) continue
      const metadata = (message as { metadata?: Record<string, unknown> }).metadata
      const value = metadata?.[GOAL_METADATA_KEY]
      if (typeof value !== "string" || value.length === 0) continue
      if (value === GOAL_CLEAR) return undefined
      const budget = metadata?.[GOAL_BUDGET_KEY] as GoalBudget | undefined
      return { condition: value, budget }
    }
    return undefined
  })
  return (
    <Show when={goal()}>
      {(value) => (
        <box paddingBottom={1} flexShrink={0}>
          <text fg={theme.text.feedback.warning.default} wrapMode="word">
            ◎ Goal: {value().condition}
            {value().budget ? ` · ${formatGoalBudget(value().budget!)}` : ""}
          </text>
        </box>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "redsun:goal-status",
  setup(context) {
    context.ui.slot({
      append: "session.composer.top",
      render: (props) => <GoalStatus context={context} sessionID={props.sessionID} />,
    })
  },
})
