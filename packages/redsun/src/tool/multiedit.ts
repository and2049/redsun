import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EditTool } from "./edit"

export const MultiEditTool = Tool.define(
  "multiedit",
  Effect.gen(function* () {
    const info = yield* EditTool
    return () =>
      Effect.gen(function* () {
        const edit = yield* info.init()
        return {
          description: "Apply multiple ordered find-and-replace edits to one file.",
          parameters: Schema.Struct({
            filePath: Schema.String,
            edits: Schema.Array(Schema.Struct({
              oldString: Schema.String,
              newString: Schema.String,
              replaceAll: Schema.optional(Schema.Boolean),
            })),
          }),
          execute: (
            input: { filePath: string; edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }> },
            ctx,
          ) =>
            Effect.gen(function* () {
              const results = yield* Effect.forEach(
                input.edits,
                (item) => edit.execute({ filePath: input.filePath, ...item }, ctx),
                { concurrency: 1 },
              )
              const last = results.at(-1)!
              return { ...last, metadata: { results: results.map((item) => item.metadata) } }
            }),
        }
      })
  }),
)
