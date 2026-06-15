import { test, expect, describe } from "bun:test"
import { Entry } from "../../src/entry/entry"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Bus } from "../../src/bus"

const projectRoot = process.cwd()

describe("Entry.append", () => {
  test("appends a CustomEntry and returns an ID starting with ent_", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const id = await Entry.append("ses_test1", { type: "custom", customType: "my-type", data: { count: 1 } })
        expect(id).toStartWith("ent_")
      },
    })
  })

  test("appends a CustomMessageEntry and returns an ID starting with ent_", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const id = await Entry.append("ses_test1", {
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
        const id1 = await Entry.append("ses_test1", { type: "custom", customType: "t", data: 1 })
        const id2 = await Entry.append("ses_test1", { type: "custom", customType: "t", data: 2 })
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
        const id = await Entry.append("ses_test_evt", { type: "custom", customType: "test-evt", data: {} })
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
        const list = await Entry.list("ses_empty")
        expect(list).toEqual([])
      },
    })
  })

  test("returns entries sorted by timestamp", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const id1 = await Entry.append("ses_sorted", { type: "custom", customType: "a", data: 1 })
        await new Promise((r) => setTimeout(r, 5))
        const id2 = await Entry.append("ses_sorted", { type: "custom", customType: "b", data: 2 })
        await new Promise((r) => setTimeout(r, 5))
        const id3 = await Entry.append("ses_sorted", { type: "custom_message", customType: "c", content: "hi", display: true })

        const list = await Entry.list("ses_sorted")
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
        await Entry.append("ses_A", { type: "custom", customType: "x", data: 1 })
        await Entry.append("ses_B", { type: "custom", customType: "x", data: 2 })

        const listA = await Entry.list("ses_A")
        const listB = await Entry.list("ses_B")
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
        await Entry.append("ses_filter", { type: "custom", customType: "alpha", data: 1 })
        await Entry.append("ses_filter", { type: "custom", customType: "beta", data: 2 })
        await Entry.append("ses_filter", { type: "custom", customType: "alpha", data: 3 })

        const alpha = await Entry.getByType("ses_filter", "alpha")
        expect(alpha.length).toBe(2)
        const beta = await Entry.getByType("ses_filter", "beta")
        expect(beta.length).toBe(1)
      },
    })
  })

  test("returns data field for custom entries, details for custom_message entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Entry.append("ses_dd", { type: "custom", customType: "x", data: { foo: 1 } })
        await Entry.append("ses_dd", { type: "custom_message", customType: "y", content: "msg", display: true, details: { bar: 2 } })

        const x = await Entry.getByType<{ foo: number }>("ses_dd", "x")
        expect(x[0].data).toEqual({ foo: 1 })

        const y = await Entry.getByType<{ bar: number }>("ses_dd", "y")
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
        const id = await Entry.append("ses_rm", { type: "custom", customType: "t", data: 1 })
        let list = await Entry.list("ses_rm")
        expect(list.length).toBe(1)

        await Entry.remove("ses_rm", id)
        list = await Entry.list("ses_rm")
        expect(list.length).toBe(0)
      },
    })
  })

  test("does not throw when removing a non-existent entry", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Entry.remove("ses_nope", "ent_nonexistent")
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
        await Entry.append("ses_bulk", { type: "custom", customType: "a", data: 1 })
        await Entry.append("ses_bulk", { type: "custom", customType: "b", data: 2 })
        await Entry.append("ses_bulk", { type: "custom_message", customType: "c", content: "x", display: true })

        let list = await Entry.list("ses_bulk")
        expect(list.length).toBe(3)

        await Entry.removeAll("ses_bulk")
        list = await Entry.list("ses_bulk")
        expect(list.length).toBe(0)
      },
    })
  })

  test("does not affect entries in other sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Entry.append("ses_keep", { type: "custom", customType: "x", data: 1 })
        await Entry.append("ses_drop", { type: "custom", customType: "x", data: 2 })

        await Entry.removeAll("ses_drop")
        const keep = await Entry.list("ses_keep")
        const drop = await Entry.list("ses_drop")
        expect(keep.length).toBe(1)
        expect(drop.length).toBe(0)
      },
    })
  })
})
