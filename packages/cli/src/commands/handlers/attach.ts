import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Attachments } from "../../services/attachments"
import { launch } from "./default"

// `redsun attach <link>`: redeem the one-time pairing link another computer's `/remote` dialog (or
// `redsun remote computers pair`) printed, keep the session token privately, and open the TUI on that server.
// Afterwards `redsun --server <url>` finds the token itself.
export default Runtime.handler(
  Commands.commands.attach,
  Effect.fn("cli.attach")(function* (input) {
    const link = yield* Effect.try({ try: () => parseLink(input.link), catch: (error) => error as Error })
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(link.href, {
          headers: { accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        }),
      catch: () => new Error(`Could not reach ${link.origin}; check the address and that computer access is on`),
    })
    if (response.status === 401)
      return yield* Effect.fail(new Error("This pairing link expired or was already used; ask for a new one"))
    if (!response.ok) return yield* Effect.fail(new Error(`Pairing failed (${response.status})`))
    const body: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new Error("The server returned an invalid pairing response"),
    })
    const token =
      typeof body === "object" && body !== null && "token" in body && typeof body.token === "string"
        ? body.token
        : undefined
    if (token === undefined) return yield* Effect.fail(new Error("The server returned no session token"))
    yield* Attachments.remember(link.origin, token)
    process.stderr.write(`Attached to ${link.origin}; later runs can use \`redsun --server ${link.origin}\`.\n`)
    yield* launch({
      server: Option.some(link.origin),
      standalone: false,
      directory: Option.none(),
      continue: false,
      session: Option.none(),
      prompt: Option.none(),
      plugin: [],
      client: Option.none(),
      auto: false,
      yolo: false,
      dangerouslySkipPermissions: false,
    })
  }),
)

/** A pairing link: an https origin plus `/auth/connect/<code>`, nothing else. */
export function parseLink(value: string) {
  const url = URL.parse(value)
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/auth\/connect\/[A-Za-z0-9_-]+$/.test(url.pathname)
  )
    throw new Error("Expected a pairing link like https://<address>/auth/connect/<code>")
  return url
}
