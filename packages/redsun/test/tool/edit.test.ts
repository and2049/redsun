import { describe, expect, test } from "bun:test"
import path from "path"
import { EditTool, replace } from "../../src/tool/edit"
import { FileTime } from "../../src/file/time"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test-edit",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

describe("tool.edit safety", () => {
  test("rejects an empty oldString", () => {
    expect(() => replace("existing", "", "replacement")).toThrow("oldString cannot be empty")
  })

  test("rejects a fuzzy match spanning substantially different content", () => {
    const content = ["start", "one", "two", "three", "end"].join("\n")
    expect(() => replace(content, ["start", "wanted", "end"].join("\n"), "replacement")).toThrow(
      "oldString not found",
    )
  })

  test("preserves UTF-8 BOM and CRLF line endings", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const filePath = path.join(tmp.path, "bom.txt")
        await Bun.write(filePath, Buffer.from("\uFEFFalpha\r\nbeta\r\n", "utf8"))
        FileTime.read(ctx.sessionID, filePath)

        const edit = await EditTool.init()
        await edit.execute({ filePath, oldString: "alpha\nbeta", newString: "one\ntwo" }, ctx)

        const bytes = Buffer.from(await Bun.file(filePath).bytes())
        expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
        expect(bytes.toString("utf8")).toBe("\uFEFFone\r\ntwo\r\n")
      },
    })
  })
})
