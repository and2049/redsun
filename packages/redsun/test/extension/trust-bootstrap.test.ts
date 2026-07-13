import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Instance } from "../../src/project/instance"
import { ExtensionRunner } from "../../src/extension/runner"
import { ToolRegistry, TrustFlag } from "../../src/tool/registry"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill/skill"
import { PromptTemplate } from "../../src/prompt/template"
import { Command } from "../../src/command"
import { tmpdir } from "../fixture/fixture"

const counters = globalThis as typeof globalThis & Record<string, unknown>

afterEach(() => {
  TrustFlag.clear()
})

async function writeProjectExecutables(dir: string, key: string, defaultProjectTrust: "always" | "never") {
  const redsun = path.join(dir, ".redsun")
  const toolDir = path.join(redsun, "tool")
  const extensionPath = path.join(dir, `${key}-extension.ts`)
  await fs.mkdir(toolDir, { recursive: true })
  await Bun.write(
    extensionPath,
    `globalThis[${JSON.stringify(key + "ExtensionImport")}] = (globalThis[${JSON.stringify(key + "ExtensionImport")}] ?? 0) + 1
    export default (api) => {
      globalThis[${JSON.stringify(key + "Extension")}] = (globalThis[${JSON.stringify(key + "Extension")}] ?? 0) + 1
      api.registerCommand({ name: ${JSON.stringify(key)}, handler() {} })
    }`,
  )
  await Bun.write(
    path.join(toolDir, `${key}.ts`),
    `globalThis[${JSON.stringify(key + "Tool")}] = (globalThis[${JSON.stringify(key + "Tool")}] ?? 0) + 1
    export default { description: "test", args: {}, async execute() { return "ok" } }`,
  )
  await Bun.write(
    path.join(redsun, "redsun.json"),
    JSON.stringify({
      defaultProjectTrust,
      extension: [pathToFileURL(extensionPath).href],
    }),
  )
}

describe("trust bootstrap executable boundary", () => {
  test("project config cannot self-authorize extensions or custom tools", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => writeProjectExecutables(dir, "self_auth", "always"),
    })
    counters.self_authExtensionImport = 0
    counters.self_authExtension = 0
    counters.self_authTool = 0

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runner = await ToolRegistry.getRunner()
        expect(runner.projectTrusted).toBe(false)
        expect(runner.commands.has("self_auth")).toBe(false)
        expect(await ToolRegistry.get("self_auth")).toBeUndefined()
        expect(counters.self_authExtensionImport).toBe(0)
        expect(counters.self_authExtension).toBe(0)
        expect(counters.self_authTool).toBe(0)

        await ToolRegistry.reload()
        expect((await ToolRegistry.getRunner()).projectTrusted).toBe(false)
        expect(counters.self_authExtensionImport).toBe(0)
        expect(counters.self_authExtension).toBe(0)
        expect(counters.self_authTool).toBe(0)
      },
    })
  })

  test("root config extensions require trust", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const extensionPath = path.join(dir, "root-config-extension.ts")
        await Bun.write(
          extensionPath,
          `export default (api) => {
            globalThis.rootConfigExtension = (globalThis.rootConfigExtension ?? 0) + 1
            api.registerCommand({ name: "root-config", handler() {} })
          }`,
        )
        await Bun.write(
          path.join(dir, "redsun.json"),
          JSON.stringify({
            defaultProjectTrust: "always",
            extension: [pathToFileURL(extensionPath).href],
          }),
        )
      },
    })
    counters.rootConfigExtension = 0

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runner = await ToolRegistry.getRunner()
        expect(runner.projectTrusted).toBe(false)
        expect(runner.commands.has("root-config")).toBe(false)
        expect(counters.rootConfigExtension).toBe(0)
      },
    })
  })

  test("trusted project extensions and custom tools load once", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => writeProjectExecutables(dir, "trusted_project", "never"),
    })
    counters.trusted_projectExtensionImport = 0
    counters.trusted_projectExtension = 0
    counters.trusted_projectTool = 0
    TrustFlag.set(true)

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const runner = await ToolRegistry.getRunner()
        expect(runner.projectTrusted).toBe(true)
        expect(runner.commands.has("trusted_project")).toBe(true)
        expect(await ToolRegistry.get("trusted_project")).toBeDefined()
        expect(counters.trusted_projectExtensionImport).toBe(1)
        expect(counters.trusted_projectExtension).toBe(1)
        expect(counters.trusted_projectTool).toBe(1)
      },
    })
  })

  test("user extension can vote on trust and stale APIs are invalidated on reload", async () => {
    await using tmp = await tmpdir({ git: true })
    await using user = await tmpdir()
    const previousConfigDir = process.env["REDSUN_CONFIG_DIR"]
    const extensionPath = path.join(user.path, "trust-voter.ts")
    await Bun.write(
      extensionPath,
      `export default (api) => {
        globalThis.__redsunTrustVoterApis ??= []
        globalThis.__redsunTrustVoterApis.push(api)
        api.on("project_trust", () => ({ trusted: "yes" }))
        api.on("session_shutdown", () => {
          globalThis.__redsunTrustVoterShutdowns = (globalThis.__redsunTrustVoterShutdowns ?? 0) + 1
        })
      }`,
    )
    await fs.mkdir(path.join(tmp.path, ".redsun"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, ".redsun", "redsun.json"),
      JSON.stringify({ extension: [pathToFileURL(extensionPath).href] }),
    )
    await Bun.write(
      path.join(user.path, "redsun.json"),
      JSON.stringify({ extension: [pathToFileURL(extensionPath).href] }),
    )
    process.env["REDSUN_CONFIG_DIR"] = user.path
    counters.__redsunTrustVoterApis = []
    counters.__redsunTrustVoterShutdowns = 0

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const first = await ToolRegistry.getRunner()
          expect(first.projectTrusted).toBe(true)
          const firstAPI = (counters.__redsunTrustVoterApis as any[])[0]
          SessionStatus.set("ses_reload", { type: "busy" })

          await ToolRegistry.reload()

          const second = await ToolRegistry.getRunner()
          expect(second.projectTrusted).toBe(true)
          expect(ExtensionRunner.isInvalidated(first)).toBe(true)
          expect(() => firstAPI.getAllTools()).toThrow("no longer valid")
          expect((counters.__redsunTrustVoterApis as any[]).length).toBe(2)
          expect(counters.__redsunTrustVoterShutdowns).toBe(1)
          SessionStatus.set("ses_reload", { type: "idle" })
        },
      })
    } finally {
      if (previousConfigDir === undefined) delete process.env["REDSUN_CONFIG_DIR"]
      else process.env["REDSUN_CONFIG_DIR"] = previousConfigDir
      delete counters.__redsunTrustVoterApis
      delete counters.__redsunTrustVoterShutdowns
    }
  })

  test("reload invalidates extension-discovered resource caches", async () => {
    await using tmp = await tmpdir({ git: true })
    await using user = await tmpdir()
    const previousConfigDir = process.env["REDSUN_CONFIG_DIR"]
    const extensionPath = path.join(user.path, "resources.ts")
    const first = path.join(tmp.path, "first")
    const second = path.join(tmp.path, "second")

    const writeResources = async (dir: string, name: string) => {
      await fs.mkdir(dir, { recursive: true })
      await Bun.write(path.join(dir, "SKILL.md"), ["---", `name: ${name}-skill`, `description: ${name} skill`, "---", ""].join("\n"))
      await Bun.write(
        path.join(dir, `${name}.md`),
        ["---", `name: ${name}-prompt`, `description: ${name} prompt`, "---", `${name} body`, ""].join("\n"),
      )
    }
    const writeExtension = (dir: string) =>
      Bun.write(
        extensionPath,
        `export default (api) => api.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(path.join(dir, "SKILL.md"))}], promptPaths: [${JSON.stringify(path.join(dir, `${path.basename(dir)}.md`))}] }))`,
      )

    await writeResources(first, "first")
    await writeResources(second, "second")
    await writeExtension(first)
    await Bun.write(path.join(user.path, "redsun.json"), JSON.stringify({ extension: [pathToFileURL(extensionPath).href] }))
    process.env["REDSUN_CONFIG_DIR"] = user.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await ToolRegistry.getRunner()
          expect(await Skill.get("first-skill")).toBeDefined()
          expect(await PromptTemplate.get("first-prompt")).toBeDefined()
          expect(await Command.get("first-prompt")).toBeDefined()

          await writeExtension(second)
          await ToolRegistry.reload()

          expect(await Skill.get("first-skill")).toBeUndefined()
          expect(await PromptTemplate.get("first-prompt")).toBeUndefined()
          expect(await Command.get("first-prompt")).toBeUndefined()
          expect(await Skill.get("second-skill")).toBeDefined()
          expect(await PromptTemplate.get("second-prompt")).toBeDefined()
          expect(await Command.get("second-prompt")).toBeDefined()
        },
      })
    } finally {
      if (previousConfigDir === undefined) delete process.env["REDSUN_CONFIG_DIR"]
      else process.env["REDSUN_CONFIG_DIR"] = previousConfigDir
    }
  })
})
