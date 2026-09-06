import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { RemoteControl } from "@opencode-ai/schema/remote-control"
import { ConflictError, ServiceUnavailableError } from "../errors.js"

export const RemoteControlGroup = HttpApiGroup.make("server.remote")
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
