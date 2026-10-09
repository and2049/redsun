export * as RemoteLocal from "./remote-local"

import { Effect, Schema } from "effect"
import { Service } from "@opencode/client/effect/service"
import { RemoteControl } from "@opencode/schema/remote-control"
import { readFile } from "node:fs/promises"
import { ServiceConfig } from "./service-config"

// Remote-control setup only ever talks to the loopback managed service that is already running: it never
// starts, replaces, or reaches a server anywhere else, and it prints no credential material.
export const connect = Effect.fn("cli.remote-local.connect")(function* () {
  const options = yield* ServiceConfig.options()
  const registration = yield* Effect.tryPromise({
    try: () => readFile(options.file, "utf8"),
    catch: () => new Error("No managed service registration; remote setup never starts a server"),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Service.Info))),
    Effect.mapError(() => new Error("Missing or invalid local service registration")),
  )
  const registeredURL = new URL(registration.url)
  if (
    registeredURL.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(registeredURL.hostname) ||
    registeredURL.username ||
    registeredURL.password
  )
    return yield* Effect.fail(new Error("Remote setup requires a loopback managed service"))
  const endpoint = yield* Service.discover({ ...options, version: undefined })
  if (!endpoint)
    return yield* Effect.fail(new Error("No ready managed service; remote setup never starts or replaces a server"))
  const url = new URL(endpoint.url)
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
    return yield* Effect.fail(new Error("Remote setup requires a loopback managed service"))
  // `timeout` is how long the backend may take to answer; operations that issue a certificate pass minutes.
  const request = (route: string, method = "GET", body?: unknown, timeout = 10_000) =>
    Effect.tryPromise({
      try: () =>
        fetch(new URL(route, endpoint.url), {
          method,
          headers: { ...Service.headers(endpoint), "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(timeout),
        }),
      catch: () => new Error("Local remote-control request failed; no credential material was printed"),
    })
  const statusResponse = yield* request("/api/remote")
  if (!statusResponse.ok) return yield* Effect.fail(new Error("Backend does not support remote-control setup"))
  const status = yield* Effect.tryPromise({
    try: () => statusResponse.json(),
    catch: () => new Error("Invalid remote status"),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RemoteControl.Status)))
  if (status.processID !== registration.id)
    return yield* Effect.fail(new Error("Managed service changed during discovery; retry local setup"))
  return { options, registration, status, request }
})

/** The message of a failed local request, for errors the backend explains. */
export const failure = (response: Response, fallback: string) =>
  Effect.tryPromise({ try: () => response.json(), catch: () => undefined }).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.map((body) =>
      typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
        ? `${fallback}: ${body.message}`
        : fallback,
    ),
  )
