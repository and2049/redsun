import { describe, expect, test } from "bun:test"
import path from "path"
import { ReadTool } from "../../src/tool/read"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

describe("tool.read external_directory permission", () => {
  test("allows reading absolute path inside project directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "hello world")
        await Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            permission: {
              external_directory: "deny",
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "test.txt") }, ctx)
        expect(result.output).toContain("hello world")
      },
    })
  })

  test("allows reading file in subdirectory inside project directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "test.txt"), "nested content")
        await Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            permission: {
              external_directory: "deny",
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "subdir", "test.txt") }, ctx)
        expect(result.output).toContain("nested content")
      },
    })
  })

  test("denies reading absolute path outside project directory", async () => {
    await using outerTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.txt"), "secret data")
      },
    })
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            permission: {
              external_directory: "deny",
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        await expect(read.execute({ filePath: path.join(outerTmp.path, "secret.txt") }, ctx)).rejects.toThrow(
          "not in the current working directory",
        )
      },
    })
  })

  test("denies reading relative path that traverses outside project directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            permission: {
              external_directory: "deny",
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        await expect(read.execute({ filePath: "../../../etc/passwd" }, ctx)).rejects.toThrow(
          "not in the current working directory",
        )
      },
    })
  })

  test("allows reading outside project directory when external_directory is allow", async () => {
    await using outerTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "external.txt"), "external content")
      },
    })
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            permission: {
              external_directory: "allow",
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(outerTmp.path, "external.txt") }, ctx)
        expect(result.output).toContain("external content")
      },
    })
  })
})

describe("tool.read env file blocking", () => {
  test.each([
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.sample", false],
    [".env.example", false],
    [".envrc", false],
    ["environment.ts", false],
  ])("%s blocked=%s", async (filename, blocked) => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, filename), "content"),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const promise = read.execute({ filePath: path.join(tmp.path, filename) }, ctx)
        if (blocked) {
          await expect(promise).rejects.toThrow("blocked")
        } else {
          expect((await promise).output).toContain("content")
        }
      },
    })
  })

  test("allows reading elsewhere in the same git worktree from a subdirectory", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "sibling.txt"), "worktree content")
        await Bun.write(path.join(dir, "redsun.json"), JSON.stringify({ permission: { external_directory: "deny" } }))
        await Bun.write(path.join(dir, "packages", "app", ".keep"), "")
      },
    })
    await Instance.provide({
      directory: path.join(tmp.path, "packages", "app"),
      fn: async () => {
        expect(Instance.containsPath(path.join(tmp.path, "sibling.txt"))).toBe(true)
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "sibling.txt") }, ctx)
        expect(result.output).toContain("worktree content")
      },
    })
  })
})

describe("tool.read bounded file handling", () => {
  test("resolves relative paths from the active project", async () => {
    await using tmp = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "relative.txt"), "project file") })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        expect((await read.execute({ filePath: "relative.txt" }, ctx)).output).toContain("project file")
      },
    })
  })

  test("sniffs supported attachment MIME from file content", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "image.txt"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: "image.txt" }, ctx)
        expect(result.attachments?.[0]?.mime).toBe("image/png")
      },
    })
  })

  test("does not send unsupported image formats as attachments", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "image.bmp"), Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0])),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        await expect(read.execute({ filePath: "image.bmp" }, ctx)).rejects.toThrow("Cannot read binary file")
      },
    })
  })

  test("caps model-visible text output by bytes", async () => {
    await using tmp = await tmpdir({
      init: (dir) => Bun.write(path.join(dir, "large.txt"), Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n")),
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: "large.txt", limit: 100 }, ctx)
        expect(result.output).toContain("Output capped at 50 KB")
        expect(result.output.length).toBeLessThan(55_000)
      },
    })
  })
})
