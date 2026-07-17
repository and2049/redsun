import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { GlobTool } from "./glob"

export const ListTool = Tool.define(
  "list",
  Effect.gen(function* () {
    const info = yield* GlobTool
    return () =>
      Effect.gen(function* () {
        const glob = yield* info.init()
        return {
          description: "List files recursively beneath a directory. Results are capped at 100 entries.",
          parameters: Schema.Struct({ path: Schema.optional(Schema.String), ignore: Schema.optional(Schema.Array(Schema.String)) }),
          execute: (input: { path?: string; ignore?: string[] }, ctx) =>
            glob.execute({ pattern: "**/*", path: input.path }, ctx),
        }
      })
  }),
)
