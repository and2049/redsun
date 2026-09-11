import { expect } from "bun:test"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Fiber, Stream } from "effect"
import { Bus } from "@opencode/core/bus"
import { SessionMessagePin as PinSchema } from "@opencode/schema/session-message-pin"
import { Database } from "@opencode/core/database/database"
import { DatabaseMigration } from "@opencode/core/database/migration"
import pinMigration from "@opencode/core/database/migration/20260911194822_session_message_pins"
import { SessionMessagePin } from "@opencode/core/session/message-pin"
import { SessionMessagePinTable, SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { testEffect } from "./lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([SessionMessagePin.node, Database.node, Global.node, Bus.node])),
)
const sessionID = Session.ID.make("ses_pins")
const messageID = SessionMessage.ID.make("msg_pins")
const target = { sessionID, messageID }
const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/pins"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      directory: AbsolutePath.make("/pins"),
      slug: "pins",
      version: "test",
    })
    .run()
  yield* db
    .insert(SessionMessageTable)
    .values({
      id: messageID,
      session_id: sessionID,
      seq: 0,
      type: "user",
      data: { text: "Original text", time: { created: 1 } },
    })
    .run()
  return db
})

it.effect("upgrades the preceding schema additively and applies the pin migration only once", () =>
  Effect.gen(function* () {
    const db = yield* seed
    yield* db.run(sql`DROP TABLE session_message_pin`)
    yield* db.run(sql`DELETE FROM migration WHERE id = ${pinMigration.id}`)
    yield* DatabaseMigration.applyOnly(db, [pinMigration])
    yield* DatabaseMigration.applyOnly(db, [pinMigration])
    const pins = yield* SessionMessagePin.Service
    yield* pins.pin(target)
    expect((yield* pins.list(sessionID)).data[0]?.preview).toBe("Original text")
    expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
    expect((yield* db.all(sql`SELECT * FROM session_message`)).length).toBe(1)
  }),
)

it.effect("keeps labels through repeated pins and removes pins on actual message and session deletion", () =>
  Effect.gen(function* () {
    const db = yield* seed
    const pins = yield* SessionMessagePin.Service
    yield* Effect.all([pins.pin(target), pins.pin(target)], { concurrency: "unbounded" })
    const before = (yield* pins.list(sessionID)).data[0]!
    yield* pins.rename(target, "  Decision  ")
    yield* pins.pin(target)
    expect((yield* pins.list(sessionID)).data).toMatchObject([{ label: "Decision", created: before.created }])
    yield* pins.rename(target, null)
    expect((yield* pins.list(sessionID)).data[0]?.label).toBeNull()
    yield* db
      .update(SessionTable)
      .set({ time_archived: 10, directory: AbsolutePath.make("/moved"), revert: { messageID } })
      .where(eq(SessionTable.id, sessionID))
      .run()
    expect((yield* pins.list(sessionID)).data).toHaveLength(1)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).run()
    expect((yield* pins.list(sessionID)).data).toEqual([])
    yield* pins.unpin(target)
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: messageID,
        session_id: sessionID,
        seq: 0,
        type: "user",
        data: { text: "Replacement", time: { created: 1 } },
      })
      .run()
    yield* pins.pin(target)
    yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
    expect(yield* db.select().from(SessionMessagePinTable).all()).toEqual([])
  }),
)

it.effect("skips pins whose message no longer decodes and keeps paging from the raw row", () =>
  Effect.gen(function* () {
    const db = yield* seed
    const pins = yield* SessionMessagePin.Service
    yield* pins.pin(target)
    yield* db.run(sql`UPDATE session_message SET data = '{}' WHERE id = ${messageID}`)
    expect(yield* pins.list(sessionID)).toEqual({ data: [] })
  }),
)

it.effect("notifies independent subscribers only after a successful mutation commits", () =>
  Effect.gen(function* () {
    yield* seed
    const bus = yield* Bus.Service
    const pins = yield* SessionMessagePin.Service
    const subscribe = bus.subscribe(PinSchema.Updated).pipe(
      Stream.take(1),
      Stream.mapEffect((event) => pins.list(event.data.sessionID)),
      Stream.runCollect,
      Effect.forkScoped,
    )
    const first = yield* subscribe
    const second = yield* subscribe
    yield* Effect.yieldNow
    yield* pins.rename(target, "Not yet pinned").pipe(Effect.flip)
    yield* pins.pin(target)
    for (const fiber of [first, second]) expect((yield* Fiber.join(fiber))[0]?.data[0]?.messageID).toBe(messageID)
  }),
)

it.effect("orders equal-time pins by message ID and rejects non-finite cursor anchors", () =>
  Effect.gen(function* () {
    const db = yield* seed
    const pins = yield* SessionMessagePin.Service
    yield* pins.pin(target)
    const other = SessionMessage.ID.make("msg_z")
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: other,
        session_id: sessionID,
        seq: 1,
        type: "assistant",
        data: {
          agent: "build",
          model: { providerID: "test", id: "test" },
          content: [],
          time: { created: 2 },
        },
      })
      .run()
    yield* pins.pin({ sessionID, messageID: other })
    yield* db
      .update(SessionMessagePinTable)
      .set({ time_created: 42 })
      .where(eq(SessionMessagePinTable.session_id, sessionID))
      .run()
    expect((yield* pins.list(sessionID)).data.map((pin) => pin.messageID)).toEqual([other, messageID])
    const page = yield* pins.list(sessionID, JSON.stringify({ time: 42, id: other }))
    expect(page.data.map((pin) => pin.messageID)).toEqual([messageID])
    const invalid = yield* pins.list(sessionID, '{"time":"Infinity","id":"msg_z"}').pipe(Effect.flip)
    expect(invalid._tag).toBe("SessionMessagePin.Invalid")
    yield* db
      .delete(SessionMessagePinTable)
      .where(and(eq(SessionMessagePinTable.session_id, sessionID), eq(SessionMessagePinTable.message_id, other)))
      .run()
    expect((yield* pins.list(sessionID)).data).toHaveLength(1)
  }),
)
