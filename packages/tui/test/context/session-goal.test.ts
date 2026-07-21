import { describe, expect, test } from "bun:test"
import { nextGoalState, type GoalEvent } from "../../src/context/session-goal"

const event = (properties: GoalEvent["properties"]): GoalEvent =>
  ({ id: crypto.randomUUID(), type: "session.goal", properties }) as GoalEvent

describe("session goal state", () => {
  test("tracks an active goal and verdict by assistant message", () => {
    const active = nextGoalState(undefined, event({ sessionID: "ses_test", goal: { condition: "ship it" } }))
    const pending = nextGoalState(
      active,
      event({
        sessionID: "ses_test",
        goal: { condition: "ship it" },
        lastVerdict: { ok: false, reason: "tests remain", attempt: 1, messageID: "msg_1" },
      }),
    )

    expect(pending?.condition).toBe("ship it")
    expect(pending?.verdicts.msg_1?.reason).toBe("tests remain")
  })

  test("retains terminal verdict through the following clear event", () => {
    const active = nextGoalState(undefined, event({ sessionID: "ses_test", goal: { condition: "ship it" } }))
    const satisfied = nextGoalState(
      active,
      event({
        sessionID: "ses_test",
        lastVerdict: { ok: true, reason: "done", attempt: 1, messageID: "msg_2" },
      }),
    )
    const cleared = nextGoalState(satisfied, event({ sessionID: "ses_test" }))

    expect(cleared?.condition).toBeUndefined()
    expect(cleared?.verdicts.msg_2?.ok).toBe(true)
  })

  test("removes manually cleared active goals", () => {
    const active = nextGoalState(undefined, event({ sessionID: "ses_test", goal: { condition: "ship it" } }))
    expect(nextGoalState(active, event({ sessionID: "ses_test" }))).toBeUndefined()
  })
})
