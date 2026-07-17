import { expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import type { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

test("session list is active-only, newest-first, and accepts Redsun and legacy directory headers", async () => {
  await using tmp = await tmpdir({ git: true })
  const app = Server.App()
  const request = (path: string, init?: RequestInit, legacy = false) =>
    app.request(`http://localhost${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        [legacy ? "x-opencode-directory" : "x-redsun-directory"]: tmp.path,
        ...init?.headers,
      },
    })
  const create = async (title: string, legacy = false) => {
    const response = await request("/session", { method: "POST", body: JSON.stringify({ title }) }, legacy)
    expect(response.status).toBe(200)
    return (await response.json()) as Session.Info
  }

  const old = await create("old", true)
  await Bun.sleep(2)
  const newest = await create("newest")
  await Bun.sleep(2)
  const archived = await create("archived")
  await request(`/session/${archived.id}`, {
    method: "PATCH",
    body: JSON.stringify({ time: { archived: Date.now() } }),
  })

  const response = await request("/session")
  expect(response.status).toBe(200)
  const sessions = (await response.json()) as Session.Info[]
  expect(sessions.map((session) => session.id)).toEqual([newest.id, old.id])

  await Promise.all([old, newest, archived].map((session) => request(`/session/${session.id}`, { method: "DELETE" })))
})
