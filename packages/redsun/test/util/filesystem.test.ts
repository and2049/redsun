import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"

describe("Filesystem.ensureDir", () => {
  test("tolerates an existing directory", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "existing")
    await fs.mkdir(dir)

    await expect(Filesystem.ensureDir(dir)).resolves.toBeUndefined()
    expect((await fs.stat(dir)).isDirectory()).toBe(true)
  })

  test("does not hide an existing file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "file")
    await Bun.write(file, "content")

    await expect(Filesystem.ensureDir(file)).rejects.toMatchObject({ code: "EEXIST" })
  })
})
