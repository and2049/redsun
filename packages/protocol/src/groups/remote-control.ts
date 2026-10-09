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
    HttpApiEndpoint.get("remote.tunnel", "/api/remote/tunnel", {
      success: RemoteControl.Tunnel,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.tunnel.get" })),
  )
  .add(
    HttpApiEndpoint.put("remote.tunnel.configure", "/api/remote/tunnel", {
      payload: RemoteControl.TunnelConfig,
      success: RemoteControl.Tunnel,
      error: [InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.tunnel.configure" })),
  )
  .add(
    HttpApiEndpoint.get("remote.computers", "/api/remote/computers", {
      success: RemoteControl.Computers,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.computers.get" })),
  )
  .add(
    HttpApiEndpoint.put("remote.computers.configure", "/api/remote/computers", {
      payload: RemoteControl.ComputersConfig,
      success: RemoteControl.Computers,
      error: [InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.computers.configure" })),
  )
  .add(
    HttpApiEndpoint.post("remote.computers.pairing", "/api/remote/computers/pairing", {
      success: RemoteControl.Pairing,
      error: ServiceUnavailableError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.computers.pairing" })),
  )
  .add(
    HttpApiEndpoint.post("remote.enable", "/api/remote/enable", {
      success: RemoteControl.Access,
      error: [InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.remote.enable" })),
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
