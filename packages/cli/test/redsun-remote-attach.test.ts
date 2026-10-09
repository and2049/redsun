import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { OPENCODE_VERSION } from "../src/version"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Attachments } from "../src/services/attachments"
import { ServerConnection } from "../src/services/server-connection"
import { parseLink } from "../src/commands/handlers/attach"

const token = (expiresInSeconds: number) => `${Math.floor(Date.now() / 1000) + expiresInSeconds}.signature`

test("pairing links are an https origin plus /auth/connect/<code>, nothing else", () => {
  expect(parseLink("https://abcd.device.opentunnel.xyz/auth/connect/c0de_-X").origin).toBe(
    "https://abcd.device.opentunnel.xyz",
  )
  for (const bad of [
    "http://abcd.device.opentunnel.xyz/auth/connect/c0de",
    "https://abcd.device.opentunnel.xyz/auth/connect/",
    "https://abcd.device.opentunnel.xyz/auth/connect/c0de?x=1",
    "https://user:pw@abcd.device.opentunnel.xyz/auth/connect/c0de",
    "https://abcd.device.opentunnel.xyz/api/info",
    "not a link",
  ])
    expect(() => parseLink(bad)).toThrow("Expected a pairing link")
})

test("attachments are stored privately per origin, expire with their token, and can be forgotten", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-attachments-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const run = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer)))
  try {
    expect(await run(Attachments.lookup("https://a.example"))).toBeUndefined()
    const live = token(3600)
    await run(Attachments.remember("https://a.example/", live))
    await run(Attachments.remember("https://b.example", token(-1)))
    expect(await run(Attachments.lookup("https://a.example/api/info"))).toEqual({
      token: live,
      expires: Attachments.expiry(live)!,
    })
    expect(await run(Attachments.lookup("https://b.example"))).toBeUndefined()
    expect(await run(Attachments.lookup("https://A.EXAMPLE"))).toMatchObject({ token: live })
    await expect(run(Attachments.remember("https://c.example", "garbage"))).rejects.toThrow("malformed")
    const file = path.join(root, "state", "attachments.json")
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await fs.readFile(file, "utf8")).not.toContain("password")
    await run(Attachments.forget("https://a.example"))
    expect(await run(Attachments.lookup("https://a.example"))).toBeUndefined()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("--server uses a stored pairing token as the password and renews it when it is about to lapse", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-attach-resolve-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))
  const accepted = new Set<string>()
  const fresh = token(30 * 24 * 3600)
  let renewals = 0
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const header = request.headers.get("authorization") ?? ""
      const secret = header.startsWith("Basic ") ? atob(header.slice(6)).split(":")[1] : undefined
      if (secret === undefined || !accepted.has(secret))
        return Response.json({ _tag: "UnauthorizedError", message: "Unauthorized" }, { status: 401 })
      const url = new URL(request.url)
      if (url.pathname === "/api/auth/session" && request.method === "POST") {
        renewals++
        accepted.add(fresh)
        return Response.json({ token: fresh })
      }
      return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [] })
    },
  })
  const url = server.url.toString().replace(/\/$/, "")
  const previous = process.env.OPENCODE_PASSWORD
  delete process.env.OPENCODE_PASSWORD
  try {
    await expect(runPromise(ServerConnection.resolve({ server: url }))).rejects.toThrow("redsun attach")
    const soon = token(24 * 3600)
    accepted.add(soon)
    await runPromise(Attachments.remember(url, soon))
    const resolved = await runPromise(ServerConnection.resolve({ server: url }))
    expect(resolved.endpoint.auth).toEqual({ type: "basic", username: "opencode", password: fresh })
    expect(renewals).toBe(1)
    expect(await runPromise(Attachments.lookup(url))).toMatchObject({ token: fresh })
    // A fresh token is used as is.
    const again = await runPromise(ServerConnection.resolve({ server: url }))
    expect(again.endpoint.auth).toMatchObject({ password: fresh })
    expect(renewals).toBe(1)
    // A revoked token explains how to pair again.
    accepted.clear()
    await expect(runPromise(ServerConnection.resolve({ server: url }))).rejects.toThrow("no longer accepts")
  } finally {
    if (previous !== undefined) process.env.OPENCODE_PASSWORD = previous
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})
