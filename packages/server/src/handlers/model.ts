import { Catalog } from "@opencode-ai/core/catalog"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    const modelsDev = yield* ModelsDev.Service
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          return yield* response(catalog.model.available())
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          return yield* response(catalog.model.default())
        }),
      )
      .handle(
        "model.refresh",
        Effect.fn(function* () {
          yield* modelsDev.refresh(true)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
