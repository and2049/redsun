import { generateObject, type ModelMessage } from "ai"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { MessageV2 } from "./message-v2"
import { Provider } from "@/provider/provider"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { Storage } from "@/storage/storage"

const log = Log.create({ service: "SessionGoal" })

export type Goal = {
  condition: string
  react: number
}

export const Verdict = z.object({
  ok: z.boolean(),
  impossible: z.boolean().optional(),
  reason: z.string(),
})
export type Verdict = z.infer<typeof Verdict>

export const Event = {
  Updated: BusEvent.define(
    "session.goal",
    z.object({
      sessionID: Identifier.schema("session"),
      goal: z.object({ condition: z.string() }).optional(),
      lastVerdict: Verdict.extend({
        attempt: z.number(),
        messageID: z.string().optional(),
        error: z.boolean().optional(),
      }).optional(),
    }),
  ),
}

const JUDGE_SYSTEM = `You are evaluating a stop-condition hook. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`

const judgeUser = (condition: string) =>
  `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

Condition: ${condition}`

export namespace Goal {
  const key = (sessionID: string) => ["session_goal", sessionID]

  export async function set(sessionID: string, condition: string) {
    await Storage.write(key(sessionID), { condition, react: 0 } satisfies Goal)
    log.info("goal set", { sessionID, condition })
    Bus.publish(Event.Updated, { sessionID, goal: { condition } })
  }

  export async function get(sessionID: string): Promise<Goal | undefined> {
    return Storage.read<Goal>(key(sessionID)).catch(() => undefined)
  }

  export async function clear(sessionID: string) {
    await Storage.remove(key(sessionID))
    log.info("goal cleared", { sessionID })
    Bus.publish(Event.Updated, { sessionID, goal: undefined })
  }

  export function publishVerdict(input: {
    sessionID: string
    goal?: { condition: string }
    verdict: Verdict
    attempt: number
    messageID?: string
    error?: boolean
  }) {
    Bus.publish(Event.Updated, {
      sessionID: input.sessionID,
      goal: input.goal,
      lastVerdict: {
        ...input.verdict,
        attempt: input.attempt,
        messageID: input.messageID,
        error: input.error,
      },
    })
  }

  export async function bumpReact(sessionID: string) {
    const goal = await get(sessionID)
    if (!goal) return 0
    const next = { ...goal, react: goal.react + 1 }
    await Storage.write(key(sessionID), next)
    return next.react
  }

  export async function evaluate(input: {
    sessionID: string
    condition: string
    msgs: MessageV2.WithParts[]
    model: Provider.Model
  }): Promise<Verdict> {
    const language = await Provider.getLanguage(input.model)

    // Use toModelMessageWithCustom so judge sees the same compacted custom-message window as the main model.
    const compactionCutoff = input.msgs.find(
      (m) => m.info.role === "user" && m.parts.some((p) => p.type === "compaction"),
    )?.info.time.created
    const conversation = await MessageV2.toModelMessageWithCustom(input.sessionID, input.msgs, compactionCutoff)

    const params = {
      temperature: 0,
      messages: [
        { role: "system", content: JUDGE_SYSTEM } as ModelMessage,
        ...conversation,
        {
          role: "user",
          content: judgeUser(input.condition),
        } as ModelMessage,
      ],
      model: language,
      schema: Verdict,
    }

    log.debug("goal judge evaluate", { condition: input.condition })
    
    const result = await generateObject(params)
    return Verdict.parse(result.object)
  }
}
