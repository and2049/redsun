import { describe, expect, test } from "bun:test"
import path from "path"
import { MultiEditTool } from "../../src/tool/multiedit"
import { Instance } from "../../src/project/instance"
import { FileTime } from "../../src/file/time"
import { tmpdir } from "../fixture/fixture"
import * as fs from "fs/promises"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

const inited = await MultiEditTool.init()

describe("multiedit schema", () => {
  test("rejects empty edits array", () => {
    const result = inited.parameters.safeParse({
      filePath: "/tmp/test.ts",
      edits: [],
    })
    expect(result.success).toBe(false)
  })

  test("accepts edits array with at least one edit", () => {
    const result = inited.parameters.safeParse({
      filePath: "/tmp/test.ts",
      edits: [
        {
          oldString: "foo",
          newString: "bar",
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  test("per-edit object does not have filePath field", () => {
    const result = inited.parameters.safeParse({
      filePath: "/tmp/test.ts",
      edits: [
        {
          filePath: "/tmp/other.ts",
          oldString: "foo",
          newString: "bar",
        },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.edits[0]).not.toHaveProperty("filePath")
    }
  })

  test("replaceAll is optional", () => {
    const result = inited.parameters.safeParse({
      filePath: "/tmp/test.ts",
      edits: [
        {
          oldString: "foo",
          newString: "bar",
          replaceAll: true,
        },
      ],
    })
    expect(result.success).toBe(true)
  })
})

describe("multiedit execute", () => {
  test("applies multiple edits sequentially", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "test.txt")
        await fs.writeFile(filePath, "alpha\nbeta\ngamma\n")
        FileTime.read(ctx.sessionID, filePath)

        const result = await inited.execute(
          {
            filePath,
            edits: [
              { oldString: "alpha", newString: "ALPHA" },
              { oldString: "beta", newString: "BETA" },
              { oldString: "gamma", newString: "GAMMA" },
            ],
          },
          ctx,
        )

        expect(result.output).toBeDefined()
        const content = await fs.readFile(filePath, "utf-8")
        expect(content).toBe("ALPHA\nBETA\nGAMMA\n")
      },
    })
  })

  test("each edit operates on result of previous edit", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "chain.txt")
        await fs.writeFile(filePath, "step1\n")
        FileTime.read(ctx.sessionID, filePath)

        await inited.execute(
          {
            filePath,
            edits: [
              { oldString: "step1", newString: "step2" },
              { oldString: "step2", newString: "step3" },
              { oldString: "step3", newString: "step4" },
            ],
          },
          ctx,
        )

        const content = await fs.readFile(filePath, "utf-8")
        expect(content).toBe("step4\n")
      },
    })
  })
})
