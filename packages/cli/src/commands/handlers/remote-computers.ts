import { Effect, Schedule, Schema } from "effect"
import { RemoteControl } from "@opencode/schema/remote-control"
import { EOL } from "node:os"
import { renderUnicodeCompact } from "uqr"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { RemoteLocal } from "../../services/remote-local"

type Request = Effect.Success<ReturnType<typeof RemoteLocal.connect>>["request"]

// Computer access: the backend itself on its own route of the device tunnel, so a redsun TUI on another
// computer can attach. The service password (or a session token from a pairing link) is its only protection,
// which is why it is opt-in and the link is printed only on request.
export default Runtime.handler(
  Commands.commands.remote.commands.computers,
  Effect.fn("cli.remote.computers")(function* (input) {
    const { status, request } = yield* RemoteLocal.connect()
    if (!status.supported) return yield* Effect.fail(new Error("Backend does not support managed remote control"))
    if (input.action === "pair") return yield* pair(request)
    if (input.action === "enable" || input.action === "rotate")
      process.stderr.write(
        "Enabling computer access; the first time this issues a certificate and can take a minute...\n",
      )
    const response =
      input.action === "status"
        ? yield* request("/api/remote/computers")
        : yield* request(
            "/api/remote/computers",
            "PUT",
            { enabled: input.action !== "disable", rotate: input.action === "rotate" },
            input.action === "disable" ? undefined : 6 * 60_000,
          )
    if (!response.ok)
      return yield* Effect.fail(
        new Error(yield* RemoteLocal.failure(response, `Computer access ${input.action} failed`)),
      )
    const value = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new Error("Invalid computer access result"),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RemoteControl.Computers)))
    console.log(JSON.stringify(value, null, 2))
    if (input.action === "rotate") console.log("Every attached computer must pair again at the new address.")
  }),
)

// Prints a one-time pairing link for `redsun attach <link>`; waits for the route to come up after an enable.
export const pair = Effect.fnUntraced(function* (request: Request) {
  const pairing = yield* Effect.gen(function* () {
    const response = yield* request("/api/remote/computers/pairing", "POST")
    if (response.status === 503) {
      const message = yield* RemoteLocal.failure(response, "Computer access is not ready")
      if (message.includes("is off"))
        return yield* Effect.fail(new Final("Computer access is off; run `redsun remote computers enable` first"))
      return yield* Effect.fail(new Error(message))
    }
    if (!response.ok) return yield* Effect.fail(new Final(yield* RemoteLocal.failure(response, "Pairing failed")))
    return yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new Error("Invalid pairing result"),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RemoteControl.Pairing)))
  }).pipe(
    Effect.retry({ while: (error) => !(error instanceof Final), schedule: Schedule.spaced("1 second") }),
    Effect.timeoutOrElse({
      duration: "3 minutes",
      orElse: () =>
        Effect.fail(new Error("Timed out waiting for computer access; run `redsun remote computers pair` again")),
    }),
  )
  process.stdout.write(
    [
      "",
      `  On the other computer, within ${Math.round(pairing.expires_in / 60)} minutes:`,
      "",
      `  redsun attach ${pairing.link}`,
      "",
      "  The link works once and grants that computer full access to this redsun, as a local TUI has.",
      "  `redsun remote computers rotate` or a new service password revokes every attached computer.",
      "",
      renderUnicodeCompact(pairing.link, { border: 2 })
        .split("\n")
        .map((line) => "  " + line)
        .join(EOL),
      "",
    ].join(EOL) + EOL,
  )
})

class Final extends Error {}
