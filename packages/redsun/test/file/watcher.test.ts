import { describe, expect, test } from "bun:test"
import path from "path"
import { realpath } from "fs/promises"
import { FileWatcher } from "../../src/file/watcher"
import { Protected } from "../../src/file/protected"
import { tmpdir } from "../fixture/fixture"

describe("file watcher paths", () => {
  test("returns no git directory for a non-git worktree", async () => {
    await using tmp = await tmpdir()
    expect(await FileWatcher.resolveGitDirectory(tmp.path)).toBeUndefined()
  })

  test("returns the canonical git directory", async () => {
    await using tmp = await tmpdir({ git: true })
    expect(await FileWatcher.resolveGitDirectory(tmp.path)).toBe(await realpath(path.join(tmp.path, ".git")))
  })

  test.skipIf(process.platform !== "win32")("protects Windows home directories from scanning", () => {
    expect(Protected.names()).toContain("AppData")
    expect(Protected.paths().some((entry) => path.basename(entry) === "AppData")).toBe(true)
  })
})
