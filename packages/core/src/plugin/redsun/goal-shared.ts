export * as RedsunGoalShared from "./goal-shared.js"

import { Schema } from "effect"

/**
 * Judge prompt, verdict contract, and continuation semantics for goal mode, ported
 * verbatim from v1's goal-shared.ts. Keep behavior changes here so the judge and the
 * loop cannot drift.
 */

export const REACT_CAP = 12

/**
 * Model-visible description of the goal feature. Only injected into the system
 * prompt while a goal is active for the session, so the feature costs no
 * context when unused (set/clear breaks the cached system prefix once).
 */
export const GOAL_FEATURE_PROMPT = [
  "<goal_feature>",
  "The /goal <condition> command sets a persistent stop condition for this session.",
  "When active, an independent judge checks the transcript before the session may stop.",
  "Use /goal with no condition to clear it.",
  "</goal_feature>",
].join("\n")

export const Verdict = Schema.Struct({
  ok: Schema.Boolean,
  impossible: Schema.optional(Schema.Boolean),
  reason: Schema.String,
})
export type Verdict = typeof Verdict.Type

export const JUDGE_INSTRUCTIONS = `You are evaluating a stop condition. Judge only from the conversation transcript.

Return JSON with {"ok":true,"reason":"evidence"} when the condition is satisfied, {"ok":false,"reason":"what is missing"} when work remains, or {"ok":false,"impossible":true,"reason":"why"} only when the condition genuinely cannot be achieved in this session. Always include a specific reason.`

/** Judge instructions ride in the user turn so the request reuses the session's cached prefix. */
export const judgeQuestion = (condition: string) =>
  `${JUDGE_INSTRUCTIONS}\n\nHas this stopping condition been satisfied?\n\nCondition: ${condition}`

export const continuationText = (condition: string, reason: string) =>
  `Your goal is not yet satisfied: "${condition}".\n\nThe independent judge noted:\n${reason}\n\nKeep working toward the goal. Do not stop until it is genuinely met or impossible.`

export function parseVerdict(input: string): Verdict {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  const value = fenced ?? (start >= 0 && end > start ? input.slice(start, end + 1) : input)
  return Schema.decodeUnknownSync(Verdict)(JSON.parse(value.trim()))
}
