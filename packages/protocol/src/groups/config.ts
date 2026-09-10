import { Config } from "@opencode/schema/config"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"
import { InvalidRequestError, UnknownError } from "../errors.js"

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.get("config.get", "/api/config", {
      query: LocationQuery,
      success: Schema.Array(Config.Entry),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.get",
          summary: "Get configuration",
          description:
            "Return configuration documents and discovery sources for the requested location, from lowest to highest priority.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("config.context.get", "/api/config/context", {
      query: LocationQuery,
      success: Config.ContextSettings,
      error: [InvalidRequestError, UnknownError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.context.get",
          summary: "Get global context settings",
          description: "Read global context-management defaults. Project configuration can override these defaults.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.patch("config.context.update", "/api/config/context", {
      query: LocationQuery,
      payload: Config.ContextSettings,
      success: Config.ContextSettings,
      error: [InvalidRequestError, UnknownError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.context.update",
          summary: "Update global context settings",
          description:
            "Persist global stale-read deduplication and compaction strategy defaults, preserving other configuration.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "config", description: "Configuration routes." }))
