import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { exportRemoteClient } from "../script/export-remote"

test("exported remote client attaches without workspace runtime dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "redsun-remote-export-"))
  try {
    const target = path.join(root, "client")
    await exportRemoteClient(target)
    const exported: typeof import("../src/promise/generated/index") = await import(
      pathToFileURL(path.join(target, "index.ts")).href
    )
    const requested: string[] = []
    const api = exported.OpenCode.make({
      baseUrl: "http://127.0.0.1:1",
      headers: { authorization: "Bearer isolated-fixture" },
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          requested.push(new URL(request.url).pathname)
          expect(request.headers.get("authorization")).toBe("Bearer isolated-fixture")
          return Response.json({
            supported: true,
            enabled: true,
            state: "unavailable",
            enrolled: true,
            backendID: "fixture",
            processID: "fixture",
            version: 1,
            leaseSeconds: 30,
          })
        },
        { preconnect: () => {} },
      ),
    })
    expect((await api.remote.status()).version).toBe(1)
    await api.remoteCatalog.theme()
    expect(requested).toEqual(["/api/remote", "/api/remote/theme"])
    expect(await readFile(path.join(target, "handoff.schema.json"), "utf8")).toContain('"token"')
    await expect(exportRemoteClient(target)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
