import { expect } from "bun:test"
import { OpenCode, type SessionMessageInfo } from "@opencode/client"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { ServerFetch } from "../src/fetch"
import path from "node:path"

const messages: SessionMessageInfo[] = [
  { id: "msg_first", type: "user", text: "Original\n  question", time: { created: 1 } },
  {
    id: "msg_answer",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [
      { type: "text", text: "An important answer" },
      { type: "text", text: "More detail" },
    ],
    finish: "stop",
    time: { created: 2, completed: 3 },
  },
  {
    id: "msg_compact",
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "Summary",
    recent: "",
    time: { created: 4 },
  },
  ...Array.from(
    { length: 110 },
    (_, index): SessionMessageInfo => ({
      id: `msg_tail_${index.toString().padStart(3, "0")}`,
      type: "user",
      text: `Later ${index}`,
      time: { created: index + 5 },
    }),
  ),
]

const setup = (database = ":memory:") =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: database },
      config: { project: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const api = OpenCode.make({
      baseUrl: "http://opencode.local",
      fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
        preconnect: fetch.preconnect,
      }),
    })
    return { api, handler }
  })

it.live("pins old user and assistant messages, validates ownership, and resets labels through generated clients", () =>
  Effect.gen(function* () {
    const { api, handler } = yield* setup()
    yield* Effect.promise(async () => {
      const template = await api.session.create({ title: "Pins" })
      const session = await api.session.import({ info: { ...template, id: Session.ID.create() }, messages })
      const target = { sessionID: session.id, messageID: "msg_answer" }
      expect(
        (await api.message.list({ sessionID: session.id, limit: 20 })).data.some(
          (message) => message.id === target.messageID,
        ),
      ).toBe(false)
      await api.message.pin(target)
      await api.message.pin({ ...target, messageID: "msg_first" })
      await api.message.renamePin({ ...target, label: "  Design decision  " })
      await api.message.pin(target)
      const pins = (await api.message.pins({ sessionID: session.id })).data
      expect(pins).toHaveLength(2)
      expect(pins.find((pin) => pin.messageID === target.messageID)).toMatchObject({
        label: "Design decision",
        preview: "An important answer More detail",
        role: "assistant",
      })
      expect(pins.find((pin) => pin.messageID === "msg_first")?.preview).toBe("Original question")
      expect(await api.session.message(target)).toEqual(messages[1]!)
      await api.message.renamePin({ ...target, label: " " })
      expect(
        (await api.message.pins({ sessionID: session.id })).data.find((pin) => pin.messageID === target.messageID)
          ?.label,
      ).toBeNull()
      await api.message.renamePin({ ...target, label: "\u{1f600}".repeat(200) })
      await api.message.renamePin({ ...target, label: ` ${"a".repeat(200)}  ` })
      await expect(api.message.renamePin({ ...target, label: "\u{1f600}".repeat(201) })).rejects.toThrow()
      await expect(api.message.renamePin({ ...target, label: "a".repeat(201) })).rejects.toThrow()
      await expect(api.message.pin({ ...target, sessionID: template.id })).rejects.toThrow()
      await expect(api.session.message({ ...target, sessionID: template.id })).rejects.toThrow()
      await expect(api.message.pin({ ...target, messageID: "msg_compact" })).rejects.toThrow()
      await expect(api.message.pin({ ...target, messageID: "msg_missing" })).rejects.toThrow()
      expect((await api.message.pins({ sessionID: template.id })).data).toEqual([])
      const badCursor = await handler(new Request(`http://opencode.local/api/session/${session.id}/pin?cursor=invalid`))
      expect(badCursor.status).toBe(400)
      await api.message.unpin(target)
      await api.message.unpin(target)
      await expect(api.message.renamePin({ ...target, label: "Removed" })).rejects.toThrow()
      expect((await api.message.pins({ sessionID: session.id })).data.map((pin) => pin.messageID)).toEqual([
        "msg_first",
      ])
    })
  }),
)

it.live(
  "pages compact pin metadata and preserves pins and labels across a server restart",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const database = path.join(directory.path, "pins.db")
      const sessionID = yield* Effect.scoped(
        Effect.gen(function* () {
          const { api } = yield* setup(database)
          return yield* Effect.promise(async () => {
            const template = await api.session.create({ title: "Persistent pins" })
            const session = await api.session.import({ info: { ...template, id: Session.ID.create() }, messages })
            for (const message of messages.filter(
              (message) => message.type === "user" || message.type === "assistant",
            )) {
              await api.message.pin({ sessionID: session.id, messageID: message.id })
            }
            await api.message.renamePin({ sessionID: session.id, messageID: "msg_first", label: "Restart bookmark" })
            return session.id
          })
        }),
      )
      const { api } = yield* setup(database)
      yield* Effect.promise(async () => {
        const first = await api.message.pins({ sessionID })
        expect(first.data).toHaveLength(100)
        expect(first.next).toBeDefined()
        const second = await api.message.pins({ sessionID, cursor: first.next })
        expect(second.data).toHaveLength(12)
        expect(second.next).toBeUndefined()
        expect(new Set([...first.data, ...second.data].map((pin) => pin.messageID)).size).toBe(112)
        expect(second.data.find((pin) => pin.messageID === "msg_first")?.label).toBe("Restart bookmark")
        expect(await api.session.message({ sessionID, messageID: "msg_first" })).toEqual(messages[0]!)
        await api.session.remove({ sessionID })
        await expect(api.message.pins({ sessionID })).rejects.toThrow()
      })
    }),
  { timeout: 30000 },
)
