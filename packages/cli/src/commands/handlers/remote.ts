import { Effect, Option, Schema } from "effect"
import { Service } from "@opencode/client/effect/service"
import { RemoteControl } from "@opencode/schema/remote-control"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServiceConfig } from "../../services/service-config"
import { createPrivateFile } from "@opencode/util/private-file"

export default Runtime.handler(
  Commands.commands.remote,
  Effect.fn("cli.remote")(function* (input) {
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
    const request = (route: string, method = "GET", body?: unknown) =>
      Effect.tryPromise({
        try: () =>
          fetch(new URL(route, endpoint.url), {
            method,
            headers: { ...Service.headers(endpoint), "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
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
    if (input.action === "status") {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    if (!status.supported) return yield* Effect.fail(new Error("Backend does not support managed remote control"))
    if (input.action === "enroll") {
      if (!status.backendID)
        return yield* Effect.fail(
          new Error(
            "Backend identity has not been persisted; fix service configuration access and run remote disable to initialize it",
          ),
        )
      const target = Option.getOrUndefined(input.handoff)
      if (!target) return yield* Effect.fail(new Error("Enrollment requires --handoff <new-private-file>"))
      const credentialID = randomBytes(16).toString("hex")
      const token = randomBytes(32).toString("base64url")
      const handoff = RemoteControl.Handoff.make({
        version: 1,
        backendID: status.backendID,
        registration: `${options.file}.remote`,
        credentialID,
        token,
      })
      yield* Effect.tryPromise({
        try: () => createPrivateFile(path.resolve(target), JSON.stringify(handoff, null, 2) + "\n"),
        catch: () =>
          new Error(
            "Private handoff creation failed; no backend credential was issued and existing files were not overwritten",
          ),
      })
      const result = yield* request("/api/remote/enrollment", "POST", {
        backendID: status.backendID,
        credentialID,
        digest: createHash("sha256").update(token).digest("hex"),
      })
      if (!result.ok)
        return yield* Effect.fail(
          new Error(
            "Enrollment not confirmed; keep the private handoff for reconciliation or revoke backend credentials before removing it",
          ),
        )
      console.log(
        "Companion enrolled. Import the private handoff locally; never send it to a browser. /remote in the TUI performs the same flow interactively.",
      )
      return
    }
    const result = yield* request(
      input.action === "revoke" ? "/api/remote/enrollment" : "/api/remote/policy",
      input.action === "revoke" ? "DELETE" : "PUT",
      input.action === "revoke" ? undefined : { enabled: input.action === "enable" },
    )
    if (!result.ok) return yield* Effect.fail(new Error("Remote-control operation failed"))
    const value = yield* Effect.tryPromise({
      try: () => result.json(),
      catch: () => new Error("Invalid remote result"),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RemoteControl.PolicyResult)))
    console.log(JSON.stringify(value, null, 2))
    if (!value.persisted)
      return yield* Effect.fail(new Error("Running state is shown above; restart persistence was NOT updated"))
  }),
)
