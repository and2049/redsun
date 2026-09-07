import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import { remoteLabel } from "../src/context/remote-control"
import type { RemoteControl } from "@opencode-ai/schema/remote-control"

test("remote labels distinguish disabled, unavailable, ready and connected", () => {
  expect(
    ["disabled", "unavailable", "ready", "connected"].map((state) =>
      remoteLabel({ state: state as RemoteControl.Status["state"] }),
    ),
  ).toEqual(["RC disabled", "RC enabled, unavailable", "RC ready", "RC connected"])
  expect(remoteLabel()).toBe("RC status unknown")
})

test("remote command works from Home without a model prompt and reports persistence failure", async () => {
  await using temporary = await tmpdir()
  const actions: string[] = []
  let status: RemoteControl.Status = {
    supported: true,
    enabled: true,
    state: "unavailable",
    enrolled: true,
    backendID: "fixture",
    processID: "process",
    version: 1,
    leaseSeconds: 30,
  }
  await using setup = await createAppFixture({
    state: temporary.path,
    fetch: (url, request) => {
      if (url.pathname === "/api/remote") return json(status)
      if (url.pathname === "/api/remote/policy") {
        actions.push(request.method)
        status = { ...status, enabled: false, state: "disabled" }
        return json({ status, persisted: false })
      }
      if (url.pathname.endsWith("/prompt")) actions.push("PROMPT")
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/RC"))
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Enable remote control"))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Restart persistence was NOT updated"))
  expect(actions).toEqual(["PUT"])
  expect(setup.captureCharFrame()).toContain("RC disabled")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("/RC"))
  expect(status.enrolled).toBe(true)
})

test.each([44, 100])("remote indicator survives Home/session navigation at width %s", async (width) => {
  await using temporary = await tmpdir()
  const session = {
    id: "ses_remote",
    title: "Remote fixture",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  let status: RemoteControl.Status = {
    supported: true,
    enabled: true,
    enrolled: true,
    state: "connected",
    backendID: "fixture",
    processID: "fixture",
    version: 1,
    leaseSeconds: 30,
  }
  await using setup = await createAppFixture({
    width,
    state: temporary.path,
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/remote") return json(status)
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname.startsWith(`/api/session/${session.id}/`)) return json({ data: [], cursor: {} })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/RC") && frame.includes("Auto-approve"))
  const connectedFg = rcIndicator(setup)?.fg
  expect(connectedFg).toBeDefined()
  status = { ...status, state: "unavailable" }
  setup.events.emit({ id: "evt_remote", created: 1, type: "remote.status", data: status })
  await setup.waitFor(() => {
    const fg = rcIndicator(setup)?.fg
    return fg !== undefined && !fg.equals(connectedFg)
  })
  await setup.mockInput.typeText("/new")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("commands") && frame.includes("/RC"))
  expect(status.enabled).toBe(true)
})

function rcIndicator(setup: Awaited<ReturnType<typeof createAppFixture>>) {
  for (const line of setup.captureSpans().lines) {
    const span = line.spans.find((span) => span.text.includes("/RC"))
    if (span) return span
  }
  return undefined
}
