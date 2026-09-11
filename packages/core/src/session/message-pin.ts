export * as SessionMessagePin from "./message-pin.js"

import { and, desc, eq, lt, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionMessagePin } from "@opencode/schema/session-message-pin"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { SessionMessagePinTable, SessionMessageTable, SessionTable } from "./sql.js"
import { SessionHistory } from "./history.js"

export class Missing extends Schema.TaggedError<Missing>()("SessionMessagePin.Missing", {
  kind: Schema.Literals(["session", "message", "pin"]),
}) {}
export class Invalid extends Schema.TaggedError<Invalid>()("SessionMessagePin.Invalid", { message: Schema.String }) {}

const Anchor = Schema.Struct({ time: Schema.Finite, id: SessionMessage.ID })
type Target = { sessionID: Session.ID; messageID: SessionMessage.ID }
export interface Interface {
  readonly list: (sessionID: Session.ID, cursor?: string) => Effect.Effect<SessionMessagePin.Page, Missing | Invalid>
  readonly pin: (target: Target) => Effect.Effect<void, Missing | Invalid>
  readonly rename: (target: Target, label: string | null) => Effect.Effect<void, Missing | Invalid>
  readonly unpin: (target: Target) => Effect.Effect<void, Missing | Invalid>
}
export class Service extends Context.Service<Service, Interface>()("redsun/SessionMessagePin") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const session = Effect.fn(function* (id: Session.ID) {
      if (
        !(yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, id))
          .get()
          .pipe(Effect.orDie))
      )
        return yield* new Missing({ kind: "session" })
    })
    const mutate = Effect.fn(function* (
      target: Target,
      action: "pin" | "rename" | "unpin",
      label: string | null = null,
    ) {
      const trimmed = label?.trim() || null
      if (trimmed && Array.from(trimmed).length > SessionMessagePin.LabelLimit)
        return yield* new Invalid({ message: `Pin labels must be at most ${SessionMessagePin.LabelLimit} characters` })
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* session(target.sessionID)
            const message = yield* tx
              .select({ type: SessionMessageTable.type })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, target.sessionID), eq(SessionMessageTable.id, target.messageID)),
              )
              .get()
              .pipe(Effect.orDie)
            if (!message && action !== "unpin") return yield* new Missing({ kind: "message" })
            if (message && message.type !== "user" && message.type !== "assistant")
              return yield* new Invalid({ message: "Only user and assistant messages can be pinned" })
            const where = and(
              eq(SessionMessagePinTable.session_id, target.sessionID),
              eq(SessionMessagePinTable.message_id, target.messageID),
            )
            if (action === "pin") {
              yield* tx
                .insert(SessionMessagePinTable)
                .values({ session_id: target.sessionID, message_id: target.messageID })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
            } else if (action === "unpin") {
              yield* tx.delete(SessionMessagePinTable).where(where).run().pipe(Effect.orDie)
            } else {
              const rows = yield* tx
                .update(SessionMessagePinTable)
                .set({ label: trimmed, time_updated: Date.now() })
                .where(where)
                .returning()
                .all()
                .pipe(Effect.orDie)
              if (!rows.length) return yield* new Missing({ kind: "pin" })
            }
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* bus.publish(SessionMessagePin.Updated, { sessionID: target.sessionID })
    })
    return Service.of({
      pin: (target) => mutate(target, "pin"),
      rename: (target, label) => mutate(target, "rename", label),
      unpin: (target) => mutate(target, "unpin"),
      list: Effect.fn(function* (sessionID, cursor) {
        yield* session(sessionID)
        const anchor = cursor
          ? yield* Effect.try({
              try: () => Schema.decodeUnknownSync(Anchor)(JSON.parse(cursor)),
              catch: () => new Invalid({ message: "Invalid pin cursor" }),
            })
          : undefined
        const rows = yield* db
          .select({ pin: SessionMessagePinTable, message: SessionMessageTable })
          .from(SessionMessagePinTable)
          .innerJoin(SessionMessageTable, eq(SessionMessageTable.id, SessionMessagePinTable.message_id))
          .where(
            and(
              eq(SessionMessagePinTable.session_id, sessionID),
              anchor
                ? or(
                    lt(SessionMessagePinTable.time_created, anchor.time),
                    and(
                      eq(SessionMessagePinTable.time_created, anchor.time),
                      lt(SessionMessagePinTable.message_id, anchor.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(SessionMessagePinTable.time_created), desc(SessionMessagePinTable.message_id))
          .limit(101)
          .all()
          .pipe(Effect.orDie)
        const page = rows.slice(0, 100)
        const data = yield* Effect.forEach(page, ({ pin, message }) =>
          Effect.gen(function* () {
            const value = yield* SessionHistory.decodeMessageRow(message).pipe(Effect.orElseSucceed(() => undefined))
            if (!value) return undefined
            return {
              sessionID,
              messageID: pin.message_id,
              label: pin.label,
              preview: Array.from(
                (value.type === "user"
                  ? value.text
                  : value.type === "assistant"
                    ? value.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("\n")
                    : ""
                )
                  .replace(/\s+/g, " ")
                  .trim(),
              )
                .slice(0, 300)
                .join(""),
              role: value.type === "user" ? ("user" as const) : ("assistant" as const),
              created: pin.time_created,
              updated: pin.time_updated,
              messageCreated: message.time_created,
            }
          }),
        )
        const last = page.at(-1)?.pin
        return {
          data: data.filter((pin) => pin !== undefined),
          ...(rows.length > 100 && last
            ? { next: JSON.stringify({ time: last.time_created, id: last.message_id }) }
            : {}),
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })
