import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { RemoteControl } from "@opencode-ai/schema/remote-control"
import { Location } from "@opencode-ai/schema/location"
import { LocationQuery } from "./location.js"
import { ServiceUnavailableError } from "../errors.js"

export const RemoteCatalogGroup = HttpApiGroup.make("server.remoteCatalog")
  .add(
    HttpApiEndpoint.get("remoteCatalog.agents", "/api/remote/agent", {
      query: LocationQuery,
      success: Location.response(Schema.Array(RemoteControl.AgentChoice)),
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remoteCatalog.agents" })),
  )
  .add(
    HttpApiEndpoint.get("remoteCatalog.models", "/api/remote/model", {
      query: LocationQuery,
      success: Location.response(Schema.Array(RemoteControl.ModelChoice)),
      error: ServiceUnavailableError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remoteCatalog.models" })),
  )
