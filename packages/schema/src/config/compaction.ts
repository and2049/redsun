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

export class Info extends Schema.Class<Info>("Config.Compaction")({
  auto: Schema.Boolean.pipe(optional),
  keep: Keep.pipe(optional),
  buffer: NonNegativeInt.pipe(optional),
  strategy: Strategy.pipe(optional).annotate({
    description:
      "Compaction strategy: llm (default), hybrid with a structured inventory, or algorithmic without an LLM call",
  }),
  max_tool_results: NonNegativeInt.pipe(optional),
  threshold: Threshold.pipe(optional).annotate({
    description:
      "Percentage of the context window at which automatic compaction runs, for native agents, Claude Code and Kiro (Kiro compacts at 80% at most). Absent: each runtime's default",
  }),
}) {}
