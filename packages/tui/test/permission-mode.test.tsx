import { expect, test } from "bun:test"
import { nextPermissionMode } from "../src/context/permission"
import { renderLocal } from "./fixture/local"
import { json } from "./fixture/tui-client"

// The runtime options arrive over the mocked client asynchronously; render passes alone don't settle them.
async function until(ready: () => boolean) {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for permission options")
    await Bun.sleep(10)
  }
}

test("the toggle alternates Manual and Auto-approve", () => {
  expect(nextPermissionMode("normal")).toBe("auto")
  expect(nextPermissionMode("auto")).toBe("normal")
})

test("another client's mode event updates the TUI without issuing a write", async () => {
  let writes = 0
  await using setup = await renderLocal({
    fetch: async (url, request) => {
      if (url.pathname !== "/api/permission/mode") return
      if (request.method === "GET") return json({ data: { mode: "normal" } })
      writes++
      return new Response(null, { status: 204 })
    },
  })
  await until(() => setup.local.permission.hydrated)
  setup.events.emit({ id: "evt_mode", created: 1, type: "permission.mode.changed", data: { mode: "auto" } })
  await until(() => setup.local.permission.mode === "auto")
  setup.events.emit({ id: "evt_manual", created: 2, type: "permission.mode.changed", data: { mode: "normal" } })
  await until(() => setup.local.permission.mode === "normal")
  expect(writes).toBe(0)
})

test("a failed write never displays unconfirmed auto-approval", async () => {
  let finish!: (response: Response) => void
  await using setup = await renderLocal({
    fetch: async (url, request) => {
      if (url.pathname !== "/api/permission/mode") return
      if (request.method === "GET") return json({ data: { mode: "normal" } })
      return new Promise<Response>((resolve) => (finish = resolve))
    },
  })
  await until(() => setup.local.permission.hydrated)
  const writing = setup.local.permission.set("auto")
  await until(() => !!finish)
  expect(setup.local.permission.mode).toBe("normal")
  finish(new Response("Failed", { status: 500 }))
  await writing
  expect(setup.local.permission.mode).toBe("normal")
})

test("a delayed initial snapshot cannot overwrite a newer mode event", async () => {
  let finish!: (response: Response) => void
  await using setup = await renderLocal({
    fetch: async (url, request) => {
      if (url.pathname === "/api/permission/mode" && request.method === "GET")
        return new Promise<Response>((resolve) => (finish = resolve))
    },
  })
  await until(() => !!finish)
  setup.events.emit({ id: "evt_mode_new", created: 1, type: "permission.mode.changed", data: { mode: "auto" } })
  await until(() => setup.local.permission.mode === "auto")
  finish(json({ data: { mode: "normal" } }))
  await setup.renderOnce()
  await Bun.sleep(20)
  expect(setup.local.permission.mode).toBe("auto")
})
