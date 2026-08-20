export * as ConfigCompaction from "./compaction.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

export class Keep extends Schema.Class<Keep>("Config.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(optional),
}) {}

export const Strategy = Schema.Literals(["hybrid", "algorithmic", "llm"])
export type Strategy = typeof Strategy.Type

export class Info extends Schema.Class<Info>("Config.Compaction")({
  auto: Schema.Boolean.pipe(optional),
  keep: Keep.pipe(optional),
  buffer: NonNegativeInt.pipe(optional),
  strategy: Strategy.pipe(optional),
  keep_recent: NonNegativeInt.pipe(optional),
  max_tool_results: NonNegativeInt.pipe(optional),
}) {}
