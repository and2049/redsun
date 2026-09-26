import { expect, test } from "bun:test"
import { effectivePermissionMode, nextPermissionMode } from "../src/context/permission"
import { renderLocal, model } from "./fixture/local"
import { json } from "./fixture/tui-client"

// The runtime options arrive over the mocked client asynchronously; render passes alone don't settle them.
async function until(ready: () => boolean) {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for permission options")
    await Bun.sleep(10)
  }
}

test("models with native approval cycle through it; others skip it", () => {
  expect(nextPermissionMode("normal", true)).toBe("native_auto")
  expect(nextPermissionMode("native_auto", true)).toBe("auto")
  expect(nextPermissionMode("auto", true)).toBe("normal")
  expect(nextPermissionMode("normal", false)).toBe("auto")
  expect(nextPermissionMode("auto", false)).toBe("normal")
  expect(effectivePermissionMode("native_auto", false)).toBe("normal")
  expect(effectivePermissionMode("native_auto", true)).toBe("native_auto")
  expect(nextPermissionMode("native_auto", false)).toBe("auto")
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

test("local permission follows the selected model's runtime without changing persisted mode on model switch", async () => {
  const writes: string[] = []
  const asked: string[] = []
  await using setup = await renderLocal({
    models: [{ ...model("sonnet"), providerID: "delegated-agent" }, model("other")],
    fetch: async (url, request) => {
      if (url.pathname === "/api/permission/mode/options") {
        const providerID = url.searchParams.get("providerID") ?? ""
        asked.push(`${providerID}/${url.searchParams.get("modelID")}`)
        return json({ data: { native: providerID === "delegated-agent" } })
      }
      if (url.pathname !== "/api/permission/mode") return
      if (request.method === "GET") return json({ data: { mode: "native_auto" } })
      writes.push(((await request.json()) as { mode: string }).mode)
      return new Response(null, { status: 204 })
    },
  })

  setup.local.model.set({ providerID: "delegated-agent", modelID: "sonnet" })
  await until(() => setup.local.permission.mode === "native_auto")
  expect(setup.local.permission.native()).toBe(true)
  setup.local.model.set({ providerID: "provider", modelID: "other" })
  await until(() => !setup.local.permission.native() && asked.includes("provider/other"))
  expect(setup.local.permission.mode).toBe("normal")
  expect(writes).toEqual([])
  await setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("auto")
  setup.local.model.set({ providerID: "delegated-agent", modelID: "sonnet" })
  expect(setup.local.permission.mode).toBe("auto")
  await setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("normal")
  await setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("native_auto")
  await setup.waitFor(() => writes.length === 3)
  expect(writes).toEqual(["auto", "normal", "native_auto"])
  // Each model's runtime is asked once.
  expect(asked.filter((key) => key === "delegated-agent/sonnet")).toHaveLength(1)
})

test("a toggle pressed before the runtime options arrive waits for them", async () => {
  const writes: string[] = []
  let answer: (() => void) | undefined
  await using setup = await renderLocal({
    models: [{ ...model("sonnet"), providerID: "delegated-agent" }],
    fetch: async (url, request) => {
      if (url.pathname === "/api/permission/mode/options") {
        await new Promise<void>((resolve) => (answer = resolve))
        return json({ data: { native: true } })
      }
      if (url.pathname !== "/api/permission/mode") return
      if (request.method === "GET") return json({ data: { mode: "normal" } })
      writes.push(((await request.json()) as { mode: string }).mode)
      return new Response(null, { status: 204 })
    },
  })

  setup.local.model.set({ providerID: "delegated-agent", modelID: "sonnet" })
  // Not known yet: the lookup this read starts is still out.
  expect(setup.local.permission.native()).toBe(false)
  await until(() => setup.local.permission.hydrated && answer !== undefined)
  const toggled = setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("normal")
  answer!()
  await toggled
  expect(setup.local.permission.native()).toBe(true)
  expect(setup.local.permission.mode).toBe("native_auto")
  await setup.waitFor(() => writes.length === 1)
  expect(writes).toEqual(["native_auto"])
})

test("the same model uses the current location's permission capabilities", async () => {
  const asked: string[] = []
  await using setup = await renderLocal({
    models: [{ ...model("sonnet"), providerID: "claude-code" }],
    fetch: async (url, request) => {
      if (url.pathname === "/api/permission/mode/options") {
        const directory = url.searchParams.get("location[directory]") ?? ""
        asked.push(directory)
        return json({ data: { native: directory === "/native-profile" } })
      }
      if (url.pathname !== "/api/permission/mode") return
      if (request.method === "GET") return json({ data: { mode: "normal" } })
      return new Response(null, { status: 204 })
    },
  })
  setup.local.model.set({ providerID: "claude-code", modelID: "sonnet" })
  setup.location.set({ directory: "/native-profile" })
  await until(() => setup.local.permission.native())
  await setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("native_auto")
  setup.location.set({ directory: "/host-only-profile" })
  await until(() => !setup.local.permission.native() && asked.includes("/host-only-profile"))
  expect(setup.local.permission.mode).toBe("normal")
  setup.location.set({ directory: "/native-profile" })
  await until(() => setup.local.permission.mode === "native_auto")
  expect(asked.filter((directory) => directory === "/native-profile")).toHaveLength(1)
})
