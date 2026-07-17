import { describe, expect, test } from "bun:test"
import path from "path"
import { createRunFilePart } from "../../src/cli/cmd/run"
import { tmpdir } from "../fixture/fixture"

describe("run file attachments", () => {
  test("attached-server files are inlined as data URLs", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "prompt.txt")
    await Bun.write(filename, "hello from the client")

    const part = await createRunFilePart(filename, true)

    expect(part.mime).toBe("text/plain")
    expect(part.url).toBe(`data:text/plain;base64,${Buffer.from("hello from the client").toString("base64")}`)
  })

  test("local files remain file URLs", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "file with spaces.txt")
    await Bun.write(filename, "local")

    const part = await createRunFilePart(filename, false)

    expect(part.url).toStartWith("file:///")
    expect(part.url).toContain("file%20with%20spaces.txt")
  })

  test("attached-server directories are rejected", async () => {
    await using tmp = await tmpdir()

    await expect(createRunFilePart(tmp.path, true)).rejects.toThrow(
      "Cannot attach local directory without a shared filesystem",
    )
  })
})
