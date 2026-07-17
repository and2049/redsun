import { expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { FileTime } from "../../src/file/time"
import { WriteTool } from "../../src/tool/write"
import { tmpdir } from "../fixture/fixture"

test("write preserves an existing UTF-8 BOM", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const filePath = path.join(tmp.path, "bom.txt")
      await Bun.write(filePath, Buffer.from("\uFEFFbefore", "utf8"))
      FileTime.read("test-write", filePath)
      const write = await WriteTool.init()
      await write.execute(
        { filePath, content: "after" },
        {
          sessionID: "test-write",
          messageID: "",
          callID: "",
          agent: "build",
          abort: AbortSignal.any([]),
          metadata: () => {},
        },
      )
      expect(Buffer.from(await Bun.file(filePath).bytes()).toString("utf8")).toBe("\uFEFFafter")
    },
  })
})
