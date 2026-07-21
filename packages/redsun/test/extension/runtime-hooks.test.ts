import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
