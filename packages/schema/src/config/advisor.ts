export * as ConfigAdvisor from "./advisor.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

export const Mode = Schema.Literals(["auto", "aside-only"])
export type Mode = typeof Mode.Type

export class Info extends Schema.Class<Info>("Config.Advisor")({
  enabled: Schema.Boolean.pipe(optional),
  model: Schema.String.pipe(optional).annotate({
    description: 'Advisor model as "provider/model-id"; defaults to the session model',
  }),
  mode: Mode.pipe(optional).annotate({
    description: '"aside-only" downgrades interrupts to asides (default: "auto")',
  }),
  cooldown_turns: NonNegativeInt.pipe(optional).annotate({
    description: "Completed turns to skip after an advisory before reviewing again (default: 1)",
  }),
  guidance: Schema.String.pipe(optional).annotate({
    description: "Inline advisor guidance; takes precedence over WATCHDOG.md/ADVISOR.md discovery",
  }),
}) {}
