import { test, expect, describe } from "bun:test"
import { Entry } from "../../src/entry/entry"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Bus } from "../../src/bus"

const projectRoot = process.cwd()
const sessionID = (name: string) => `ses_entry_${name}_${Math.random().toString(36).slice(2)}`

describe("Entry.append", () => {
  test("appends a CustomEntry and returns an ID starting with ent_", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const id = await Entry.append(sessionID("append_custom"), { type: "custom", customType: "my-type", data: { count: 1 } })
        expect(id).toStartWith("ent_")
      },
    })
  })

  test("appends a CustomMessageEntry and returns an ID starting with ent_", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const id = await Entry.append(sessionID("append_message"), {
          type: "custom_message",
          customType: "my-type",
          content: "Hello LLM",
          display: true,
        })
        expect(id).toStartWith("ent_")
      },
    })
  })

  test("generates unique IDs for sequential appends", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sid = sessionID("unique")
        const id1 = await Entry.append(sid, { type: "custom", customType: "t", data: 1 })
        const id2 = await Entry.append(sid, { type: "custom", customType: "t", data: 2 })
        expect(id1).not.toBe(id2)
      },
    })
  })

  test("publishes Entry.Event.Appended on append", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let received: { sessionID: string; entryID: string; customType: string; type: string } | undefined
        const unsub = Bus.subscribe(Entry.Event.Appended, (event) => {
          received = event.properties as any
        })
        const sid = sessionID("event")
        const id = await Entry.append(sid, { type: "custom", customType: "test-evt", data: {} })
        await new Promise((resolve) => setTimeout(resolve, 50))
        unsub()
        expect(received).toBeDefined()
        expect(received?.entryID).toBe(id)
        expect(received?.customType).toBe("test-evt")
        expect(received?.type).toBe("custom")
      },
    })
  })
})

describe("Entry.list", () => {
  test("returns empty array for session with no entries", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const list = await Entry.list(sessionID("empty"))
        expect(list).toEqual([])
      },
    })
  })

  test("returns entries sorted by timestamp", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sid = sessionID("sorted")
        const id1 = await Entry.append(sid, { type: "custom", customType: "a", data: 1 })
        await new Promise((r) => setTimeout(r, 5))
        const id2 = await Entry.append(sid, { type: "custom", customType: "b", data: 2 })
        await new Promise((r) => setTimeout(r, 5))
        const id3 = await Entry.append(sid, { type: "custom_message", customType: "c", content: "hi", display: true })

        const list = await Entry.list(sid)
        expect(list.length).toBe(3)
        expect(list[0].id).toBe(id1)
        expect(list[1].id).toBe(id2)
        expect(list[2].id).toBe(id3)
        expect(list[0].timestamp).toBeLessThanOrEqual(list[1].timestamp)
        expect(list[1].timestamp).toBeLessThanOrEqual(list[2].timestamp)
      },
    })
  })

  test("only returns entries for the given sessionID", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sidA = sessionID("a")
        const sidB = sessionID("b")
        await Entry.append(sidA, { type: "custom", customType: "x", data: 1 })
        await Entry.append(sidB, { type: "custom", customType: "x", data: 2 })

        const listA = await Entry.list(sidA)
        const listB = await Entry.list(sidB)
        expect(listA.length).toBe(1)
        expect(listB.length).toBe(1)
        expect((listA[0] as any).data).toBe(1)
        expect((listB[0] as any).data).toBe(2)
      },
    })
  })
})

describe("Entry.getByType", () => {
  test("filters entries by customType", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = sessionID("filter")
        await Entry.append(sid, { type: "custom", customType: "alpha", data: 1 })
        await Entry.append(sid, { type: "custom", customType: "beta", data: 2 })
        await Entry.append(sid, { type: "custom", customType: "alpha", data: 3 })

        const alpha = await Entry.getByType(sid, "alpha")
        expect(alpha.length).toBe(2)
        const beta = await Entry.getByType(sid, "beta")
        expect(beta.length).toBe(1)
      },
    })
  })

  test("returns data field for custom entries, details for custom_message entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = sessionID("data_details")
        await Entry.append(sid, { type: "custom", customType: "x", data: { foo: 1 } })
        await Entry.append(sid, { type: "custom_message", customType: "y", content: "msg", display: true, details: { bar: 2 } })

        const x = await Entry.getByType<{ foo: number }>(sid, "x")
        expect(x[0].data).toEqual({ foo: 1 })

        const y = await Entry.getByType<{ bar: number }>(sid, "y")
        expect(y[0].details).toEqual({ bar: 2 })
      },
    })
  })
})

describe("Entry.remove", () => {
  test("removes a single entry", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = sessionID("remove")
        const id = await Entry.append(sid, { type: "custom", customType: "t", data: 1 })
        let list = await Entry.list(sid)
        expect(list.length).toBe(1)

        await Entry.remove(sid, id)
        list = await Entry.list(sid)
        expect(list.length).toBe(0)
      },
    })
  })

  test("does not throw when removing a non-existent entry", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Entry.remove(sessionID("missing"), "ent_nonexistent")
      },
    })
  })
})

describe("Entry.removeAll", () => {
  test("removes all entries for a session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = sessionID("bulk")
        await Entry.append(sid, { type: "custom", customType: "a", data: 1 })
        await Entry.append(sid, { type: "custom", customType: "b", data: 2 })
        await Entry.append(sid, { type: "custom_message", customType: "c", content: "x", display: true })

        let list = await Entry.list(sid)
        expect(list.length).toBe(3)

        await Entry.removeAll(sid)
        list = await Entry.list(sid)
        expect(list.length).toBe(0)
      },
    })
  })

  test("does not affect entries in other sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const keepID = sessionID("keep")
        const dropID = sessionID("drop")
        await Entry.append(keepID, { type: "custom", customType: "x", data: 1 })
        await Entry.append(dropID, { type: "custom", customType: "x", data: 2 })

        await Entry.removeAll(dropID)
        const keep = await Entry.list(keepID)
        const drop = await Entry.list(dropID)
        expect(keep.length).toBe(1)
        expect(drop.length).toBe(0)
      },
    })
  })
})

describe("Entry.removeBefore", () => {
  test("removes entries with timestamp before cutoff", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = sessionID("prune")
        const id1 = await Entry.append(sid, { type: "custom", customType: "old", data: 1 })
        await new Promise((r) => setTimeout(r, 10))
        const cutoff = Date.now()
        await new Promise((r) => setTimeout(r, 10))
        const id2 = await Entry.append(sid, { type: "custom", customType: "new", data: 2 })

        const removed = await Entry.removeBefore(sid, cutoff)
        expect(removed).toBe(1)

        const remaining = await Entry.list(sid)
        expect(remaining.length).toBe(1)
        expect(remaining[0].id).toBe(id2)
      },
    })
  })

  test("removes nothing when all entries are after cutoff", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sid = sessionID("all_new")
        await Entry.append(sid, { type: "custom", customType: "x", data: 1 })
        const cutoff = 0

        const removed = await Entry.removeBefore(sid, cutoff)
        expect(removed).toBe(0)

        const remaining = await Entry.list(sid)
        expect(remaining.length).toBe(1)
      },
    })
  })
})
