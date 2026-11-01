import { Model } from "@opencode/schema/model"
import { Location } from "@opencode/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const ListQuery = Schema.Struct({
  ...LocationQuery.fields,
  types: Schema.optional(Schema.ArrayEnsure(Model.Type)).annotate({
    description: "Only list models of these types. Defaults to chat, the only type offered for sessions.",
  }),
})

export const ModelGroup = HttpApiGroup.make("server.model")
  .add(
    HttpApiEndpoint.get("model.list", "/api/model", {
      query: ListQuery,
      success: Location.response(Schema.Array(Model.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "model.list",
          summary: "List models",
          description:
            "Retrieve the current snapshot of available models of the requested types, chat by default, ordered by release date within each type. The snapshot may precede initial plugin settlement.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("model.refresh", "/api/model/refresh", {
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.model.refresh",
          summary: "Refresh models",
          description:
            "Force a re-fetch of the models.dev catalog and republish the model list regardless of cache age.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("model.default", "/api/model/default", {
      query: LocationQuery,
      success: Location.response(Schema.UndefinedOr(Model.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "model.default",
          summary: "Get default model",
          description: "Retrieve the model used when a session has no explicit model selection.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "model",
      description: "Experimental model routes.",
    }),
  )
