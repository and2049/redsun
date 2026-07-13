import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { MCP } from "../../src/mcp"
import { TrustFlag } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  TrustFlag.clear()
})

test("does not start a local MCP declared by an untrusted project config", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const marker = path.join(dir, "mcp-started")
      const server = path.join(dir, "mcp-server.js")
      await Bun.write(server, `Bun.write(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 60_000)`)
      await Bun.write(
        path.join(dir, "redsun.json"),
        JSON.stringify({
          mcp: {
            project_local: {
              type: "local",
              command: [process.execPath, server],
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect((await MCP.status()).project_local).toEqual({ status: "disabled" })
      expect(await Bun.file(path.join(tmp.path, "mcp-started")).exists()).toBe(false)
    },
  })
})
