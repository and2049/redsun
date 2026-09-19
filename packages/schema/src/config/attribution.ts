export * as ConfigAttribution from "./attribution.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.Attribution")({
  commit: Schema.Union([Schema.Boolean, Schema.String])
    .pipe(optional)
    .annotate({
      description:
        "Add a Co-authored-by trailer to commits the agent creates: true for the redsun-agent identity, or a custom trailer line",
    }),
}) {}
