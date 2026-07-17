import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ExtensionRuntime } from "../../src/extension/runtime"

const dirs: string[] = []

async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "redsun-extension-trust-"))
  dirs.push(dir)
  return dir
}

const plugin = (directory: string) => ({ directory, worktree: directory, project: {} }) as PluginInput
const exists = (file: string) => readFile(file, "utf8").then(() => true, () => false)

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("extension trust loading", () => {
  test("does not import project extensions when a user extension denies trust", async () => {
    const dir = await temp()
    const user = path.join(dir, "user.ts")
    const project = path.join(dir, "project.ts")
    const marker = path.join(dir, "project-loaded")
    await writeFile(user, `export default (api) => api.on("project_trust", () => ({ trusted: "no" }))`)
    await writeFile(project, `await Bun.write(${JSON.stringify(marker)}, "loaded"); export default () => {}`)

    const runtime = await ExtensionRuntime.create({
      plugin: plugin(dir),
      userEntries: [user],
      projectEntries: [project],
      defaultTrust: "always",
    })

    expect(runtime.trusted).toBe(false)
    expect(await exists(marker)).toBe(false)
    await runtime.hooks.dispose?.()
  })

  test("loads project extensions once after a user extension grants trust", async () => {
    const dir = await temp()
    const user = path.join(dir, "user.ts")
    const project = path.join(dir, "project.ts")
    const marker = path.join(dir, "project-loaded")
    const contextMarker = path.join(dir, "project-context")
    await writeFile(user, `export default (api) => api.on("project_trust", () => ({ trusted: "yes" }))`)
    await writeFile(
      project,
      `await Bun.write(${JSON.stringify(marker)}, "loaded"); export default (api) => api.on("session_start", (_event, ctx) => Bun.write(${JSON.stringify(contextMarker)}, String(ctx.isProjectTrusted())))`,
    )

    const runtime = await ExtensionRuntime.create({
      plugin: plugin(dir),
      userEntries: [user],
      projectEntries: [project],
      defaultTrust: "never",
    })

    expect(runtime.trusted).toBe(true)
    expect(await readFile(marker, "utf8")).toBe("loaded")
    expect(await readFile(contextMarker, "utf8")).toBe("true")
    await runtime.hooks.dispose?.()
  })
})
