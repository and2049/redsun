export * as Attachments from "./attachments"

import { Effect, Schema } from "effect"
import { Global } from "@opencode/util/global"
import { createPrivateFile } from "@opencode/util/private-file"
import { readFile, rename, mkdir, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"

// Session tokens that `redsun attach <link>` redeemed, one per server origin, so `--server <url>` needs no
// password afterwards. The file is private (0600 / protected ACL) and never holds a password: a token dies
// with the host's password rotation, its computer-address rotation, or its 30-day expiry.

const Entry = Schema.Struct({
  token: Schema.String,
  /** Unix seconds, taken from the token itself (`<expires>.<signature>`). */
  expires: Schema.Int,
})
export type Entry = typeof Entry.Type
const Store = Schema.Struct({ version: Schema.Literal(1), servers: Schema.Record(Schema.String, Entry) })
type Store = typeof Store.Type
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Store))

export const file = Effect.gen(function* () {
  const global = yield* Global.Service
  return path.join(global.state, "attachments.json")
})

const load = Effect.fn("cli.attachments.load")(function* () {
  const target = yield* file
  const text = yield* Effect.tryPromise({ try: () => readFile(target, "utf8"), catch: () => undefined }).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  if (text === undefined) return { version: 1, servers: {} } satisfies Store
  const parsed = decode(text)
  return parsed._tag === "Some" ? parsed.value : ({ version: 1, servers: {} } satisfies Store)
})

const save = Effect.fn("cli.attachments.save")(function* (store: Store) {
  const target = yield* file
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(target), { recursive: true })
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await createPrivateFile(temporary, JSON.stringify(store, null, 2) + "\n")
        await rename(temporary, target)
      } finally {
        await rm(temporary, { force: true })
      }
    },
    catch: () => new Error("Unable to store the attachment privately"),
  })
})

/** Seconds since the epoch at which a session token stops working, or undefined for a malformed token. */
export function expiry(token: string) {
  const seconds = Number(token.split(".")[0])
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

export const remember = Effect.fn("cli.attachments.remember")(function* (origin: string, token: string) {
  const expires = expiry(token)
  if (expires === undefined) return yield* Effect.fail(new Error("The server issued a malformed session token"))
  const store = yield* load()
  yield* save({ version: 1, servers: { ...store.servers, [new URL(origin).origin]: { token, expires } } })
  return { token, expires }
})

export const forget = Effect.fn("cli.attachments.forget")(function* (origin: string) {
  const store = yield* load()
  const { [new URL(origin).origin]: _removed, ...servers } = store.servers
  yield* save({ version: 1, servers })
})

/** The stored, unexpired token for a server URL. */
export const lookup = Effect.fn("cli.attachments.lookup")(function* (url: string, now = Date.now()) {
  const origin = URL.parse(url)?.origin
  if (origin === undefined) return undefined
  const entry = (yield* load()).servers[origin]
  if (entry === undefined || entry.expires * 1000 <= now) return undefined
  return entry
})

/** Tokens are renewed when fewer than this many seconds remain, so a regularly used attachment never lapses. */
export const RENEW_WITHIN_SECONDS = 7 * 24 * 60 * 60
