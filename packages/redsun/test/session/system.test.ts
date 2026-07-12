import { test, expect, describe } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { SystemPrompt } from "../../src/session/system"
import { Log } from "../../src/util/log"

Log.init({ print: false })

test("selects the Redsun Meta prompt for Muse Spark", () => {
  const prompt = SystemPrompt.provider({ api: { id: "meta/muse-spark-preview" } } as any)[0]
  expect(prompt).toContain("Redsun powered by Meta Muse Spark")
  expect(prompt).not.toContain("TodoWrite")
})

describe("SystemPrompt.environmentStable", () => {
  test("contains working directory and platform but not date or file tree", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await SystemPrompt.environmentStable()
        const joined = result.join(" ")
        expect(joined).toContain("Working directory:")
        expect(joined).toContain("Platform:")
        expect(joined).not.toContain("Today's date:")
        expect(joined).not.toContain("<files>")
      },
    })
  })
})

describe("SystemPrompt.environmentVolatile", () => {
  test("contains today's date", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await SystemPrompt.environmentVolatile()
        const joined = result.join(" ")
        expect(joined).toContain("Today's date:")
        expect(joined).toContain(new Date().toDateString())
      },
    })
  })

  test("does not contain stable environment fields", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await SystemPrompt.environmentVolatile()
        const joined = result.join(" ")
        expect(joined).not.toContain("Working directory:")
        expect(joined).not.toContain("Is directory a git repo:")
        expect(joined).not.toContain("Platform:")
      },
    })
  })

  test("includes file tree for git repos", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "dummy.txt"), "content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await SystemPrompt.environmentVolatile()
        const joined = result.join(" ")
        expect(joined).toContain("<files>")
        expect(joined).toContain("</files>")
      },
    })
  })
})
