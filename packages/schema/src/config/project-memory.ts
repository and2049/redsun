export * as ConfigProjectMemory from "./project-memory.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.ProjectMemory")({
  load: Schema.Literals(["outline", "full"])
    .pipe(optional)
    .annotate({
      description:
        "How .redsun/memory.md enters model context: outline sends its preamble and a heading index with line ranges for on-demand reads; full sends the whole file (default: outline)",
    }),
}) {}
