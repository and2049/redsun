import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { WebSearchTool } from "./websearch"

export const CodeSearchTool = Tool.define(
  "codesearch",
  Effect.gen(function* () {
    const info = yield* WebSearchTool
    return () =>
      Effect.gen(function* () {
        const search = yield* info.init()
        return {
          description: "Search current API, library, and SDK documentation and examples.",
          parameters: Schema.Struct({ query: Schema.String, tokensNum: Schema.optional(Schema.Number) }),
          execute: (input: { query: string; tokensNum?: number }, ctx) =>
            search.execute({
              query: `${input.query} API library SDK code documentation`,
              contextMaxCharacters: input.tokensNum ? Math.min(20_000, input.tokensNum * 4) : 10_000,
            }, ctx),
        }
      })
  }),
)
