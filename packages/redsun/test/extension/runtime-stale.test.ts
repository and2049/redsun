import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ExtensionRuntime } from "../../src/extension/runtime"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("extension reload invalidation", () => {
  test("rejects captured APIs after the runtime is replaced", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "redsun-extension-stale-"))
    dirs.push(directory)
    const extension = path.join(directory, "stale.ts")
    const result = path.join(directory, "result.txt")
    await writeFile(
      extension,
      `export default (api) => setTimeout(() => {
        try {
          api.setActiveTools(["read"])
          Bun.write(${JSON.stringify(result)}, "accepted")
        } catch (error) {
          Bun.write(${JSON.stringify(result)}, error.message)
        }
      }, 50)`,
    )
    const plugin = { directory, worktree: directory, project: {} } as unknown as PluginInput
    await ExtensionRuntime.create({ plugin, userEntries: [extension], projectEntries: [], defaultTrust: "never" })
    const runtime = await ExtensionRuntime.create({ plugin, userEntries: [], projectEntries: [], defaultTrust: "never" })

    for (let index = 0; index < 20 && !(await Bun.file(result).exists()); index++) await Bun.sleep(10)
    expect(await readFile(result, "utf8")).toContain("no longer valid")
    await runtime.hooks.dispose?.()
  })
})
