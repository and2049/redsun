import { expect, test } from "bun:test"
import { effectivePermissionMode, nextPermissionMode } from "../src/context/permission"
import { renderLocal, model } from "./fixture/local"
import { json } from "./fixture/tui-client"

test("cycles Claude Code through approve-for-me and auto, but other models skip approve-for-me", () => {
  expect(nextPermissionMode("normal", "claude-code")).toBe("claude_auto")
  expect(nextPermissionMode("claude_auto", "claude-code")).toBe("auto")
  expect(nextPermissionMode("auto", "claude-code")).toBe("normal")
  expect(nextPermissionMode("normal", "provider")).toBe("auto")
  expect(nextPermissionMode("auto", "provider")).toBe("normal")
  expect(effectivePermissionMode("claude_auto", "provider")).toBe("normal")
  expect(effectivePermissionMode("claude_auto")).toBe("normal")
  expect(nextPermissionMode("claude_auto", "provider")).toBe("auto")
})

test("local permission follows the selected main model without changing persisted mode on model switch", async () => {
  const writes: string[] = []
  await using setup = await renderLocal({
    models: [{ ...model("sonnet"), providerID: "claude-code" }, model("other")],
    fetch: async (url, request) => {
      if (url.pathname !== "/api/permission/mode") return
      if (request.method === "GET") return json({ data: { mode: "claude_auto" } })
      writes.push(((await request.json()) as { mode: string }).mode)
      return new Response(null, { status: 204 })
    },
  })

  setup.local.model.set({ providerID: "claude-code", modelID: "sonnet" })
  expect(setup.local.permission.mode).toBe("claude_auto")
  setup.local.model.set({ providerID: "provider", modelID: "other" })
  expect(setup.local.permission.mode).toBe("normal")
  expect(writes).toEqual([])
  setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("auto")
  setup.local.model.set({ providerID: "claude-code", modelID: "sonnet" })
  expect(setup.local.permission.mode).toBe("auto")
  setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("normal")
  setup.local.permission.toggle()
  expect(setup.local.permission.mode).toBe("claude_auto")
  await setup.waitFor(() => writes.length === 3)
  expect(writes).toEqual(["auto", "normal", "claude_auto"])
})
