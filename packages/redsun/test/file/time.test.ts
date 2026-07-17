import { describe, expect, test } from "bun:test"
import { utimes } from "fs/promises"
import path from "path"
import { FileTime } from "../../src/file/time"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("file time", () => {
  test.skipIf(process.platform !== "win32")("normalizes slash direction", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "file.txt")
        await Bun.write(file, "content")
        FileTime.read("session", file.replaceAll("\\", "/"))
        expect(FileTime.get("session", file)).toBeInstanceOf(Date)
        await FileTime.assert("session", file)
      },
    })
  })

  test("allows filesystem timestamp fuzz within 50ms", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "file.txt")
        await Bun.write(file, "content")
        FileTime.read("session", file)
        const read = FileTime.get("session", file)!
        await utimes(file, read, new Date(read.getTime() + 25))
        await FileTime.assert("session", file)
        await utimes(file, read, new Date(read.getTime() + 100))
        await expect(FileTime.assert("session", file)).rejects.toThrow("modified since it was last read")
      },
    })
  })
})
