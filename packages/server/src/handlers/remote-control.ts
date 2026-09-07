import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "@opencode-ai/protocol/errors"
import { Api } from "../api"
import { RemoteService } from "../remote-control"

export const RemoteHandler = HttpApiBuilder.group(Api, "server.remote", (handlers) =>
  Effect.gen(function* () {
    const remote = yield* RemoteService.Service
    return handlers
      .handle("remote.companion", () => remote.companion())
      .handle("remote.companion.configure", ({ payload }) =>
        remote.configure(payload).pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message }))),
      )
      .handle("remote.companion.register", () =>
        remote.registration.open.pipe(
          Effect.mapError((error) => new ConflictError({ message: error.message })),
          Effect.as(HttpApiSchema.NoContent.make()),
        ),
      )
      .handle("remote.companion.cancel", () =>
        remote.registration.cancel.pipe(
          Effect.mapError((error) => new ConflictError({ message: error.message })),
          Effect.as(HttpApiSchema.NoContent.make()),
        ),
      )
      .handle("remote.companion.approve", ({ payload }) =>
        remote.approve(payload.requestID, payload.fingerprint).pipe(
          Effect.mapError((error) => new ConflictError({ message: error.message })),
          Effect.as(HttpApiSchema.NoContent.make()),
        ),
      )
      .handle("remote.tailscale", () =>
        remote.tailscale.inspect.pipe(
          Effect.mapError((error) => new ServiceUnavailableError({ message: error.message })),
        ),
      )
      .handle("remote.tailscale.apply", () =>
        remote.tailscale.apply.pipe(
          Effect.mapError((error) => new ServiceUnavailableError({ message: error.message })),
        ),
      )
      .handle("remote.status", () => Effect.sync(remote.status))
      .handle("remote.policy", ({ payload }) => remote.policy(payload.enabled))
      .handle("remote.revoke", () => remote.revoke)
      .handle("remote.enroll", ({ payload }) =>
        Effect.gen(function* () {
          if (!(yield* remote.enroll(payload)))
            return yield* new ConflictError({
              message: "Enrollment was not persisted; verify backend identity, capacity, and configuration access",
            })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("remote.heartbeat", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* Effect.serviceOption(RemoteService.Principal)
          if (principal._tag === "Some") remote.heartbeat(principal.value, payload.connected)
          return remote.status()
        }),
      )
  }),
)
