import { test, expect } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { resolveTaskModel } from "../../src/provider/router"
import { Log } from "../../src/util/log"

Log.init({ print: false })

test("resolveTaskModel calls fallback when no task_router config", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let fallbackCalled = false
      const result = await resolveTaskModel("compact", async () => {
        fallbackCalled = true
        return undefined
      })
      expect(fallbackCalled).toBe(true)
      expect(result).toBeUndefined()
    },
  })
})

test("resolveTaskModel calls fallback when task_router has invalid model", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          $schema: "https://redsun.ai/config.json",
          task_router: {
            compact: "nonexistent-provider/nonexistent-model",
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let fallbackCalled = false
      const result = await resolveTaskModel("compact", async () => {
        fallbackCalled = true
        return undefined
      })
      expect(fallbackCalled).toBe(true)
      expect(result).toBeUndefined()
    },
  })
})

test("resolveTaskModel with unknown slot calls fallback", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let fallbackCalled = false
      await resolveTaskModel("explore" as any, async () => {
        fallbackCalled = true
        return undefined
      })
      expect(fallbackCalled).toBe(true)
    },
  })
})
