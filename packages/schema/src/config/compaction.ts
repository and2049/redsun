export * as ConfigCompaction from "./compaction.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

export class Keep extends Schema.Class<Keep>("Config.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(optional),
}) {}

export const Strategy = Schema.Literals(["hybrid", "algorithmic", "llm"])
export type Strategy = typeof Strategy.Type

/** Percentage of the context window at which automatic compaction runs. */
export const Threshold = Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 95 }))

/** A share of the model's window such as "20%" or "12.5%", from 1% up to but not including 100%. */
export const Percent = Schema.String.check(Schema.isPattern(/^([1-9]\d?(\.\d+)?)%$/u)).annotate({
  identifier: "Config.Compaction.Percent",
})
export type Percent = typeof Percent.Type

export class Info extends Schema.Class<Info>("Config.Compaction")({
  auto: Schema.Boolean.pipe(optional),
  keep: Keep.pipe(optional),
  buffer: Schema.Union([Percent, NonNegativeInt]).pipe(optional).annotate({
    description:
      'Room kept free below the model\'s context window before automatic compaction, as a share of the window from "1%" to "99%", such as "20%" to compact at 80% full. A token count is also accepted.',
  }),
  strategy: Strategy.pipe(optional).annotate({
    description:
      "Compaction strategy: llm (default), hybrid with a structured inventory, or algorithmic without an LLM call",
  }),
  max_tool_results: NonNegativeInt.pipe(optional),
  threshold: Threshold.pipe(optional).annotate({
    description:
      "Percentage of the context window at which automatic compaction runs, for native agents and Kiro (Kiro compacts at 80% at most). Absent: each runtime's default",
  }),
}) {}
