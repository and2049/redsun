import type { Event } from "@opencode-ai/sdk/v2"

export type GoalEvent = Extract<Event, { type: "session.goal" }>
export type GoalVerdict = NonNullable<GoalEvent["properties"]["lastVerdict"]>

export type SessionGoalState = {
  condition?: string
  lastVerdict?: GoalVerdict
  verdicts: Record<string, GoalVerdict>
}

export function nextGoalState(previous: SessionGoalState | undefined, event: GoalEvent): SessionGoalState | undefined {
  const { goal, lastVerdict } = event.properties
  if (goal && !lastVerdict) return { condition: goal.condition, verdicts: {} }

  if (lastVerdict) {
    const verdicts = { ...previous?.verdicts }
    if (lastVerdict.messageID) verdicts[lastVerdict.messageID] = lastVerdict
    return {
      condition: goal?.condition,
      lastVerdict,
      verdicts,
    }
  }

  // Goal.clear follows terminal verdict publication. Retain that verdict for
  // the transcript, but remove manually cleared active goals.
  if (!previous?.condition && previous?.lastVerdict) return previous
  return undefined
}
