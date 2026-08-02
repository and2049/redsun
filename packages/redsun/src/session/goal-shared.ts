import { Schema } from "effect"

/**
 * Judge prompt, verdict contract, and continuation semantics shared between the V1
 * goal service (`goal.ts`) and the v2 continuation-policy port (`goal-v2.ts`).
 * Keep behavior changes here so the two runtimes cannot drift.
 */

export const REACT_CAP = 12

export const Verdict = Schema.Struct({
  ok: Schema.Boolean,
  impossible: Schema.optional(Schema.Boolean),
  reason: Schema.String,
})
export type Verdict = typeof Verdict.Type

export const JUDGE_SYSTEM = `You are evaluating a stop condition. Judge only from the conversation transcript.

Return JSON with {"ok":true,"reason":"evidence"} when the condition is satisfied, {"ok":false,"reason":"what is missing"} when work remains, or {"ok":false,"impossible":true,"reason":"why"} only when the condition genuinely cannot be achieved in this session. Always include a specific reason.`

export const judgeQuestion = (condition: string) =>
  `Has this stopping condition been satisfied?\n\nCondition: ${condition}`

export const continuationText = (condition: string, reason: string) =>
  `Your goal is not yet satisfied: "${condition}".\n\nThe independent judge noted:\n${reason}\n\nKeep working toward the goal. Do not stop until it is genuinely met or impossible.`

export function parseVerdict(input: string): Verdict {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  const value = fenced ?? (start >= 0 && end > start ? input.slice(start, end + 1) : input)
  return Schema.decodeUnknownSync(Verdict)(JSON.parse(value.trim()))
}
