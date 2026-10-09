import { Effect, Option, Schedule, Schema } from "effect"
import { RemoteControl } from "@opencode/schema/remote-control"
import { RemoteTunnel } from "@opencode/server/remote-tunnel"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { EOL } from "node:os"
import { renderUnicodeCompact } from "uqr"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { RemoteLocal } from "../../services/remote-local"
import { ServiceConfig } from "../../services/service-config"
import { createPrivateFile } from "@opencode/util/private-file"

export default Runtime.handler(
  Commands.commands.remote,
  Effect.fn("cli.remote")(function* (input) {
    const { options, status, request } = yield* RemoteLocal.connect()
    if (input.action === "status") {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    if (input.action === "attach") return yield* attach(request)
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

type Request = Effect.Success<ReturnType<typeof RemoteLocal.connect>>["request"]

// The backend's own route on the device tunnel, which `redsun service set remote true` creates: a redsun TUI
// on another computer attaches with `--server`. The service password is its only protection, so it is opt-in
// and never printed here.
const attach = Effect.fnUntraced(function* (request: Request) {
  const route = (yield* ServiceConfig.read()).remote?.route
  if (route === undefined)
    return yield* Effect.fail(
      new Error("The attach address is off; run `redsun service set remote true` to create it, then run this again"),
    )
  const url = yield* attachURL(request, route)
  process.stdout.write(
    [
      "",
      "  Attach a redsun TUI from another computer:",
      "",
      `  OPENCODE_PASSWORD=<password> redsun --server ${url}`,
      "",
      "  The password is this computer's service password (`redsun service get password`); it is the only",
      "  protection on this address, which exposes the whole local API.",
      "",
      renderUnicodeCompact(url, { border: 2 })
        .split("\n")
        .map((line) => "  " + line)
        .join(EOL),
      "",
    ].join(EOL) + EOL,
  )
})

// The service attaches the tunnel in the background, so wait for its URL to appear in server info.
const attachURL = Effect.fnUntraced(function* (request: Request, route: string) {
  const decodeInfo = Schema.decodeUnknownEffect(Schema.Struct({ urls: Schema.Array(Schema.String) }))
  const tunnelURL = Effect.gen(function* () {
    const hostname = yield* RemoteTunnel.hostname()
    const response = yield* request("/api/info")
    if (!response.ok) return yield* Effect.fail(new Error("Server info is unavailable"))
    const info = yield* Effect.tryPromise({ try: () => response.json(), catch: () => new Error("Invalid server info") }).pipe(
      Effect.flatMap(decodeInfo),
    )
    const expected = hostname === undefined ? undefined : `${route}.${hostname}`
    const url = info.urls.find((candidate) => expected !== undefined && new URL(candidate).hostname === expected)
    if (url === undefined) return yield* Effect.fail(new Error("Remote tunnel is not ready"))
    return url
  })
  return yield* tunnelURL.pipe(
    Effect.retry({ schedule: Schedule.spaced("1 second") }),
    Effect.timeoutOrElse({
      duration: "3 minutes",
      orElse: () =>
        Effect.fail(new Error("Timed out waiting for the remote tunnel; run `redsun remote attach` again to retry")),
    }),
  )
})
