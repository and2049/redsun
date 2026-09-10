import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { RemoteControl } from "@opencode/schema/remote-control"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "../errors.js"

export const RemoteControlGroup = HttpApiGroup.make("server.remote")
  .add(
    HttpApiEndpoint.get("remote.companion", "/api/remote/companion", {
      success: RemoteControl.Companion,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.companion.get" })),
  )
  .add(
    HttpApiEndpoint.put("remote.companion.configure", "/api/remote/companion", {
      payload: RemoteControl.CompanionConfig,
      success: RemoteControl.Companion,
      error: InvalidRequestError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.companion.configure" })),
  )
  .add(
    HttpApiEndpoint.post("remote.companion.register", "/api/remote/companion/registration", {
      success: HttpApiSchema.NoContent,
      error: ConflictError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.companion.register" })),
  )
  .add(
    HttpApiEndpoint.delete("remote.companion.cancel", "/api/remote/companion/registration", {
      success: HttpApiSchema.NoContent,
      error: ConflictError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.companion.cancel" })),
  )
  .add(
    HttpApiEndpoint.post("remote.companion.approve", "/api/remote/companion/approval", {
      payload: RemoteControl.Approval,
      success: HttpApiSchema.NoContent,
      error: ConflictError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.companion.approve" })),
  )
  .add(
    HttpApiEndpoint.get("remote.tailscale", "/api/remote/tailscale", {
      success: RemoteControl.Tailscale,
      error: ServiceUnavailableError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.tailscale.get" })),
  )
  .add(
    HttpApiEndpoint.post("remote.tailscale.apply", "/api/remote/tailscale", {
      success: RemoteControl.Tailscale,
      error: ServiceUnavailableError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.tailscale.apply" })),
  )
  .add(
    HttpApiEndpoint.get("remote.status", "/api/remote", { success: RemoteControl.Status }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.remote.status" }),
    ),
  )
  .add(
    HttpApiEndpoint.put("remote.policy", "/api/remote/policy", {
      payload: RemoteControl.Preference,
      success: RemoteControl.PolicyResult,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.policy" })),
  )
  .add(
    HttpApiEndpoint.post("remote.enroll", "/api/remote/enrollment", {
      payload: RemoteControl.Enrollment,
      success: HttpApiSchema.NoContent,
      error: [ConflictError, ServiceUnavailableError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.enroll" })),
  )
  .add(
    HttpApiEndpoint.delete("remote.revoke", "/api/remote/enrollment", {
      success: RemoteControl.PolicyResult,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.revoke" })),
  )
  .add(
    HttpApiEndpoint.post("remote.heartbeat", "/api/remote/heartbeat", {
      payload: RemoteControl.Heartbeat,
      success: RemoteControl.Status,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.heartbeat" })),
  )
