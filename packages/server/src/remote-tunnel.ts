export * as RemoteTunnel from "./remote-tunnel"

import type { OpenTunnelError } from "@opentunnel/client/effect"
import { Cause, Effect, Schedule } from "effect"

// OpenTunnel keeps one tunnel per device in its default profile, shared by the opentunnel CLI and every app
// using the SDK; each claims its own routes. Redsun claims subdomains (routes) rather than the tunnel
// hostname, which the CLI may route. Tunnel hostnames appear in public certificate logs but the certificate
// covers subdomains with a wildcard, so a random route keeps an address unguessable. A route is not
// authentication: the backend route stays behind the service password and the companion route behind passkeys.

export type Routes = Readonly<Record<string, string>>

export type Input = {
  /** Route label to loopback target, for example `{ a1b2: "127.0.0.1:43123" }`. */
  readonly routes: Routes
  /** The tunnel hostname once the routes are attached; `undefined` whenever the attachment drops. */
  readonly onHostname: (hostname: string | undefined) => void
  /** Called once when the tunnel stops for good (rejected token, failed certificate); transient failures retry. */
  readonly onFailure?: (message: string) => void
}

// Holds the routes for the life of the caller. The SDK reconnects through network failures itself, so only
// setup failures reach the retry here; a rejected token or failed certificate stops it for good.
export const run = Effect.fnUntraced(function* (input: Input) {
  const { OpenTunnelClient, OpenTunnelAttachError } = yield* Effect.promise(() => import("@opentunnel/client/effect"))
  const fatal = (error: OpenTunnelError) =>
    error._tag === "OpenTunnelClientError" &&
    (error.cause instanceof OpenTunnelAttachError || error.message.startsWith("Certificate issuance failed"))
  yield* Effect.gen(function* () {
    const client = yield* OpenTunnelClient
    const connection = yield* client.tunnel.connect({ routes: input.routes })
    input.onHostname(connection.tunnel.hostname)
    yield* connection.closed
  }).pipe(
    Effect.scoped,
    Effect.ensuring(Effect.sync(() => input.onHostname(undefined))),
    Effect.tapError((error) =>
      fatal(error) ? Effect.void : Effect.logWarning("remote access tunnel unavailable; retrying", { cause: error }),
    ),
    Effect.retry({
      while: (error) => !fatal(error),
      schedule: Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")]),
    }),
    Effect.provide(OpenTunnelClient.layer()),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const message = Cause.prettyErrors(cause)[0]?.message || "Remote access tunnel stopped"
      return Effect.logError("remote access tunnel stopped", { cause }).pipe(
        Effect.andThen(Effect.sync(() => input.onFailure?.(message))),
      )
    }),
  )
})

// A device without a tunnel creates its shared one here, because issuing the certificate takes a while;
// afterwards callers only attach routes. An interrupted issuance resumes next time. Resolves to the hostname.
export const ensure = Effect.fnUntraced(function* (input?: { readonly onIssuing?: () => void }) {
  const { OpenTunnelClient } = yield* Effect.promise(() => import("@opentunnel/client/effect"))
  return yield* Effect.gen(function* () {
    const client = yield* OpenTunnelClient
    if ((yield* client.tunnel.get()) === undefined) input?.onIssuing?.()
    return (yield* client.tunnel.ensure()).hostname
  }).pipe(
    Effect.provide(OpenTunnelClient.layer()),
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () => Effect.fail(new Error("Timed out creating the remote access tunnel; run the command again to resume")),
    }),
  )
})

// The tunnel hostname is persisted once the certificate is ready, so this is undefined until then.
export const hostname = Effect.fnUntraced(function* () {
  const { OpenTunnelStorage } = yield* Effect.promise(() => import("@opentunnel/client/effect"))
  const identity = yield* OpenTunnelStorage.xdg().load("default")
  return identity?.hostname
})
