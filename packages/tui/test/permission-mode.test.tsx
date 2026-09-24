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
  setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("auto")
  setup.local.model.set({ providerID: "delegated-agent", modelID: "sonnet" })
  expect(setup.local.permission.mode).toBe("auto")
  setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("normal")
  setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("native_auto")
  await setup.waitFor(() => writes.length === 3)
  expect(writes).toEqual(["auto", "normal", "native_auto"])
  // Each model's runtime is asked once.
  expect(asked.filter((key) => key === "delegated-agent/sonnet")).toHaveLength(1)
})
