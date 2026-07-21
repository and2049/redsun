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

async function runtime(source: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "redsun-extension-hooks-"))
  dirs.push(directory)
  const extension = path.join(directory, "hooks.ts")
  await writeFile(extension, source)
  const plugin = {
    directory,
    worktree: directory,
    project: {},
    client: { session: { promptAsync: async () => ({ data: undefined }) } },
  } as unknown as PluginInput
  return {
    directory,
    runtime: await ExtensionRuntime.create({
      plugin,
      userEntries: [extension],
      projectEntries: [],
      defaultTrust: "never",
    }),
  }
}

describe("extension runtime hooks", () => {
  test("mutates normalized MCP results and preserves the error flag", async () => {
    const item = await runtime(`export default (api) => {
      api.on("tool_result", (event) => ({
        output: "redacted:" + event.output,
        metadata: { isError: event.isError },
      }))
    }`)
    const output = { title: "", output: "secret", metadata: {}, isError: true }

    await item.runtime.hooks["tool.execute.after"]?.(
      { tool: "server_tool", sessionID: `ses_${crypto.randomUUID()}`, callID: "call_1", args: {} },
      output,
    )

    expect(output).toEqual({ title: "", output: "redacted:secret", metadata: { isError: true }, isError: true })
    await item.runtime.hooks.dispose?.()
  })

  test("allows tool result hooks to clear the error flag", async () => {
    const item = await runtime(`export default (api) => {
      api.on("tool_result", () => ({ output: "recovered", isError: false }))
    }`)
    const output = { title: "", output: "failed", metadata: {}, isError: true }

    await item.runtime.hooks["tool.execute.after"]?.(
      { tool: "server_tool", sessionID: `ses_${crypto.randomUUID()}`, callID: "call_1", args: {} },
      output,
    )

    expect(output).toEqual({ title: "", output: "recovered", metadata: {}, isError: false })
    await item.runtime.hooks.dispose?.()
  })

  test("updates the live tool hook map after startup", async () => {
    const item = await runtime(`export default (api) => {
      api.registerCommand({
        name: "tools",
        handler: async (args) => {
          if (args === "remove") return api.unregisterTool("dynamic")
          await api.registerTool({
            id: "dynamic",
            init: () => ({
              description: "dynamic tool",
              parameters: { shape: {} },
              execute: () => ({ title: "dynamic", output: "ok", metadata: {} }),
            }),
          })
        },
      })
    }`)
    const sessionID = `ses_${crypto.randomUUID()}`

    expect(item.runtime.hooks.tool?.dynamic).toBeUndefined()
    await ExtensionRuntime.runCommand(item.directory, "tools", "add", sessionID, "build")
    expect(item.runtime.hooks.tool?.dynamic?.description).toBe("dynamic tool")
    await ExtensionRuntime.runCommand(item.directory, "tools", "remove", sessionID, "build")
    expect(item.runtime.hooks.tool?.dynamic).toBeUndefined()
    await item.runtime.hooks.dispose?.()
  })

  test("maps handled input and compaction cancellation into plugin hooks", async () => {
    const item = await runtime(`export default (api) => {
      api.on("input", () => ({ action: "handled" }))
      api.on("session_before_compact", () => ({ cancel: true }))
    }`)
    const sessionID = `ses_${crypto.randomUUID()}`
    const message = {
      message: {
        id: "msg_test",
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "test", modelID: "test" },
      },
      parts: [{ id: "part_test", sessionID, messageID: "msg_test", type: "text", text: "hello" }],
      handled: false,
    } as any
    const compacting = { context: [] as string[], prompt: undefined as string | undefined, cancel: false }

    await item.runtime.hooks["chat.message"]?.({ sessionID, agent: "build" }, message)
    await item.runtime.hooks["experimental.session.compacting"]?.({ sessionID }, compacting)

    expect(message.handled).toBe(true)
    expect(compacting.cancel).toBe(true)
    await item.runtime.hooks.dispose?.()
  })

  test("reports reload lifecycle reasons", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "redsun-extension-lifecycle-"))
    dirs.push(directory)
    const log = path.join(directory, "events.log")
    const extension = path.join(directory, "hooks.ts")
    await writeFile(
      extension,
      `import { appendFile } from "node:fs/promises"
      export default (api) => {
        for (const type of ["resources_discover", "agents_register", "session_start", "session_shutdown"]) {
          api.on(type, (event) => appendFile(${JSON.stringify(log)}, type + ":" + event.reason + "\\n"))
        }
      }`,
    )
    const plugin = {
      directory,
      worktree: directory,
      project: {},
      client: { session: { promptAsync: async () => ({ data: undefined }) } },
    } as unknown as PluginInput
    const create = () =>
      ExtensionRuntime.create({ plugin, userEntries: [extension], projectEntries: [], defaultTrust: "never" })

    const first = await create()
    ExtensionRuntime.prepareReload(directory)
    await first.hooks.dispose?.()
    const second = await create()
    await second.hooks.dispose?.()

    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "resources_discover:startup",
      "agents_register:startup",
      "session_start:startup",
      "session_shutdown:reload",
      "resources_discover:reload",
      "agents_register:reload",
      "session_start:reload",
      "session_shutdown:quit",
    ])
  })

  test("injects only custom messages created after the latest compaction", async () => {
    const item = await runtime(`export default (api) => {
      api.registerCommand({
        name: "append",
        handler: (args, ctx) => api.appendCustomMessageEntry(ctx.sessionID, "test.context", args),
      })
    }`)
    const sessionID = `ses_${crypto.randomUUID()}`

    await ExtensionRuntime.runCommand(item.directory, "append", "before", sessionID, "build")
    expect(await ExtensionRuntime.customMessages(sessionID)).toEqual(["before"])
    await item.runtime.hooks.event?.({
      event: { type: "session.compacted", properties: { sessionID } },
    })
    await ExtensionRuntime.runCommand(item.directory, "append", "after", sessionID, "build")

    expect(await ExtensionRuntime.customMessages(sessionID)).toEqual(["after"])
    await item.runtime.hooks.dispose?.()
  })
})
