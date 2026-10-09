import { Effect, Schema } from "effect"
import { RemoteControl } from "@opencode/schema/remote-control"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { RemoteLocal } from "../../services/remote-local"

// Phone access: the managed service attaches the companion's route to the device's OpenTunnel tunnel and
// keeps the route across disable, because the phones' passkeys are bound to the origin it forms.
export default Runtime.handler(
  Commands.commands.remote.commands.tunnel,
  Effect.fn("cli.remote.tunnel")(function* (input) {
    const { status, request } = yield* RemoteLocal.connect()
    if (!status.supported) return yield* Effect.fail(new Error("Backend does not support managed remote control"))
    if (input.action === "enable" || input.action === "rotate")
      process.stderr.write("Enabling phone access; the first time this issues a certificate and can take a minute...\n")
    // The backend waits for the certificate before answering an enable, which takes minutes the first time.
    const response =
      input.action === "status"
        ? yield* request("/api/remote/tunnel")
        : yield* request(
            "/api/remote/tunnel",
            "PUT",
            { enabled: input.action !== "disable", rotate: input.action === "rotate" },
            input.action === "disable" ? undefined : 6 * 60_000,
          )
    if (!response.ok)
      return yield* Effect.fail(new Error(yield* RemoteLocal.failure(response, `Phone access ${input.action} failed`)))
    const value = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new Error("Invalid phone access result"),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RemoteControl.Tunnel)))
    console.log(JSON.stringify(value, null, 2))
    if (input.action === "rotate") console.log("Every phone must enroll again at the new address.")
  }),
)
