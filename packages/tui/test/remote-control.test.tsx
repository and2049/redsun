import { expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import { remoteLabel } from "../src/context/remote-control"
import { RemoteControl } from "@opencode/schema/remote-control"

test("remote labels distinguish disabled, unavailable, ready and connected", () => {
  expect(
    ["disabled", "unavailable", "ready", "connected"].map((state) =>
      remoteLabel({ state: state as RemoteControl.Status["state"] }),
    ),
  ).toEqual(["RC disabled", "RC enabled, unavailable", "RC ready", "RC connected"])
  expect(remoteLabel()).toBe("RC status unknown")
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
  await setup.waitForFrame((frame) => frame.includes("/RC") && frame.includes("Manual"))
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

function companionEnvironment(directory: string) {
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
  process.env.LOCALAPPDATA = directory
  process.env.XDG_DATA_HOME = directory
  return {
    [Symbol.dispose]() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

// A local managed launch: the dialog manages access only when the TUI has a local service registration.
function managed(root: string) {
  return {
    registration: path.join(root, "service.json.remote"),
    reconnect: async () => {
      throw new Error("Unexpected reconnect")
    },
    restart: async () => {
      throw new Error("Unexpected restart")
    },
  }
}

const ready: RemoteControl.Status = {
  supported: true,
  enabled: true,
  enrolled: true,
  state: "ready",
  backendID: "fixture",
  processID: "process",
  version: 1,
  leaseSeconds: 30,
}
const origin = "https://abcd1234abcd1234.device.opentunnel.xyz"

test("turning on phone access is one call: enrolls, creates the address, enables", async () => {
  await using temporary = await tmpdir()
  using _environment = companionEnvironment(temporary.path)
  const actions: string[] = []
  let status: RemoteControl.Status = { ...ready, enabled: false, enrolled: false, state: "disabled" }
  let companion: RemoteControl.Companion = { running: false, port: 43123, pending: [] }
  let tunnel: RemoteControl.Tunnel = { enabled: false, state: "off" }
  await using setup = await createAppFixture({
    state: temporary.path,
    width: 140,
    service: managed(temporary.path),
    fetch: (url, request) => {
      if (url.pathname === "/api/remote") return json(status)
      if (url.pathname === "/api/remote/companion") return json(companion)
      if (url.pathname === "/api/remote/tunnel") return json(tunnel)
      if (url.pathname === "/api/remote/enable") {
        actions.push(request.method)
        status = { ...status, enabled: true, enrolled: true, state: "unavailable" }
        tunnel = { enabled: true, origin, state: "ready" }
        companion = { running: true, origin, port: 43123, pending: [] }
        return json({ status, tunnel, companion })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/ commands"), { maxPasses: 200 })
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Turn on phone access") && frame.includes("Phones: off"))
  expect(setup.captureCharFrame()).not.toContain("Enroll a companion")
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) =>
      frame.includes("Add a phone") &&
      frame.includes("Turn off phone access") &&
      frame.includes(`Phones: ready — ${origin}`),
  )
  expect(actions).toEqual(["POST"])
  expect(setup.captureCharFrame()).toContain("Companion starting")
})

test("turning off phone access from Home keeps the address, sends no prompt and reports persistence failure", async () => {
  await using temporary = await tmpdir()
  using _environment = companionEnvironment(temporary.path)
  const actions: string[] = []
  let status: RemoteControl.Status = { ...ready, state: "unavailable" }
  await using setup = await createAppFixture({
    state: temporary.path,
    service: managed(temporary.path),
    fetch: (url, request) => {
      if (url.pathname === "/api/remote") return json(status)
      if (url.pathname === "/api/remote/companion") return json({ running: true, origin, port: 43123, pending: [] })
      if (url.pathname === "/api/remote/tunnel") return json({ enabled: true, origin, state: "ready" })
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
  await setup.waitFor(() => setup.renderer.currentFocusedEditor != null)
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Turn off phone access"))
  // Add a phone, Show phone link, Turn off phone access
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Restart persistence was NOT updated"))
  expect(actions).toEqual(["PUT"])
  expect(setup.captureCharFrame()).toContain("Turn on phone access")
  expect(setup.captureCharFrame()).toContain("disabled")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("/RC"))
  expect(status.enrolled).toBe(true)
})

test.each(["success", "registered"] as const)(
  "adding a phone %s opens the window and shows the link",
  async (outcome) => {
    await using temporary = await tmpdir()
    using _environment = companionEnvironment(temporary.path)
    const actions: string[] = []
    await using setup = await createAppFixture({
      state: temporary.path,
      width: 180,
      height: 60,
      service: managed(temporary.path),
      fetch: (url, request) => {
        if (url.pathname === "/api/remote") return json(ready)
        if (url.pathname === "/api/remote/companion") return json({ running: true, origin, port: 43123, pending: [] })
        if (url.pathname === "/api/remote/tunnel") return json({ enabled: true, origin, state: "ready" })
        if (url.pathname === "/api/remote/companion/registration") {
          actions.push(request.method)
          if (outcome === "registered")
            return Response.json(
              { _tag: "ConflictError", message: "An owner passkey is already registered" },
              { status: 409 },
            )
          return new Response(null, { status: 204 })
        }
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("/RC"))
    await setup.waitFor(() => setup.renderer.currentFocusedEditor != null)
    await setup.mockInput.typeText("/remote")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Add a phone") && frame.includes("No phone yet"))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) =>
      frame.includes(
        outcome === "registered" ? "An owner passkey is already registered" : "Scan to open the companion on a phone",
      ),
    )
    expect(actions).toEqual(["POST"])
    if (outcome === "success") {
      expect(setup.captureCharFrame()).toContain(origin)
      setup.mockInput.pressEscape()
      await setup.waitForFrame((frame) => !frame.includes("Phone link"))
    }
  },
)

test("phone approvals stay local and confirmed", async () => {
  await using temporary = await tmpdir()
  using _environment = companionEnvironment(temporary.path)
  let approved = 0
  let companion: RemoteControl.Companion = {
    running: true,
    origin,
    port: 43123,
    pending: [{ requestID: "fixture-request", fingerprint: "ABCD-EFGH" }],
  }
  await using setup = await createAppFixture({
    state: temporary.path,
    width: 160,
    height: 60,
    service: managed(temporary.path),
    fetch: async (url, request) => {
      if (url.pathname === "/api/remote") return json(ready)
      if (url.pathname === "/api/remote/companion") return json(companion)
      if (url.pathname === "/api/remote/tunnel") return json({ enabled: true, origin, state: "ready" })
      if (url.pathname === "/api/remote/companion/approval") {
        expect(Schema.decodeUnknownSync(RemoteControl.Approval)(await request.json())).toEqual(companion.pending[0])
        approved++
        companion = { ...companion, pending: [] }
        return new Response(null, { status: 204 })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/RC"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor != null)
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Approve phone ABCD-EFGH"))
  // Add a phone, Approve phone
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Confirm: approve ABCD-EFGH"))
  expect(approved).toBe(0)
  expect(setup.captureCharFrame()).toContain("match the phone screen exactly")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => approved === 1)
  await setup.waitForFrame((frame) => !frame.includes("Approve phone ABCD-EFGH"))
})

test("computer access is confirmed before turning on, pairs with a one-time link, and turns off", async () => {
  await using temporary = await tmpdir()
  using _environment = companionEnvironment(temporary.path)
  const configured: RemoteControl.ComputersConfig[] = []
  let pairings = 0
  let computers: RemoteControl.Computers = { enabled: false, state: "off" }
  const address = "https://0123456789abcdef.device.opentunnel.xyz"
  await using setup = await createAppFixture({
    state: temporary.path,
    width: 160,
    height: 60,
    service: managed(temporary.path),
    fetch: async (url, request) => {
      if (url.pathname === "/api/remote") return json(ready)
      if (url.pathname === "/api/remote/companion") return json({ running: true, origin, port: 43123, pending: [] })
      if (url.pathname === "/api/remote/tunnel") return json({ enabled: true, origin, state: "ready" })
      if (url.pathname === "/api/remote/computers") {
        if (request.method === "PUT") {
          const config = Schema.decodeUnknownSync(RemoteControl.ComputersConfig)(await request.json())
          configured.push(config)
          computers = config.enabled
            ? { enabled: true, origin: address, state: "ready" }
            : { enabled: false, state: "off" }
        }
        return json(computers)
      }
      if (url.pathname === "/api/remote/computers/pairing") {
        pairings++
        return json({ link: `${address}/auth/connect/c0de`, code: "c0de", expires_in: 300 })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/RC"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor != null)
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Turn on computer access") && frame.includes("Computers: off"))
  expect(setup.captureCharFrame()).not.toContain("Add a computer")
  // Add a phone, Show phone link, Turn off phone access, Turn on computer access
  for (let i = 0; i < 3; i++) setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Confirm: any computer that pairs gets full access"))
  expect(configured).toEqual([])
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) => frame.includes("Add a computer") && frame.includes(`Computers: ready — ${address}`),
  )
  expect(configured).toEqual([{ enabled: true }])
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Computer link") && frame.includes("the link works once"))
  expect(pairings).toBe(1)
  expect(setup.captureCharFrame().replace(/\s+/g, " ")).toContain(`redsun attach ${address}/auth/connect/c0de`)
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Computer link"))
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Turn off computer access"))
  // Add a phone, Show phone link, Turn off phone access, Add a computer, Show computer address, Turn off computer access
  for (let i = 0; i < 5; i++) setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Turn on computer access") && frame.includes("Computers: off"))
  expect(configured).toEqual([{ enabled: true }, { enabled: false }])
})

test("advanced: a new phone address needs confirmation and forgetting everything revokes", async () => {
  await using temporary = await tmpdir()
  using _environment = companionEnvironment(temporary.path)
  const configured: RemoteControl.TunnelConfig[] = []
  const actions: string[] = []
  let status: RemoteControl.Status = { ...ready, state: "connected" }
  let tunnel: RemoteControl.Tunnel = { enabled: true, origin, state: "ready" }
  await using setup = await createAppFixture({
    state: temporary.path,
    width: 160,
    height: 60,
    service: managed(temporary.path),
    fetch: async (url, request) => {
      if (url.pathname === "/api/remote") return json(status)
      if (url.pathname === "/api/remote/companion")
        return json({ running: true, origin: tunnel.origin, port: 43123, pending: [] })
      if (url.pathname === "/api/remote/tunnel") {
        if (request.method === "PUT") {
          const config = Schema.decodeUnknownSync(RemoteControl.TunnelConfig)(await request.json())
          configured.push(config)
          tunnel = { enabled: true, origin: "https://feedbeefcafe0123.device.opentunnel.xyz", state: "ready" }
        }
        return json(tunnel)
      }
      if (url.pathname === "/api/remote/enrollment") {
        actions.push(request.method)
        status = { ...status, enrolled: false, state: "unavailable" }
        return json({ status, persisted: true })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/RC"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor != null)
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("New phone address") && frame.includes("Phone connected"))
  expect(setup.captureCharFrame()).not.toContain("Add a phone")
  // Show phone link, Turn off phone access, Turn on computer access, New phone address
  for (let i = 0; i < 3; i++) setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Confirm: new phone address; every phone must enroll again"))
  expect(configured).toEqual([])
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("https://feedbeefcafe0123.device.opentunnel.xyz"))
  expect(configured).toEqual([{ enabled: true, rotate: true }])
  // ..., New phone address, Use a custom phone address, Forget all phones and credentials
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Confirm: forget all phones and credentials"))
  expect(actions).toEqual([])
  setup.mockInput.pressEnter()
  await setup.waitFor(() => actions.length === 1)
  expect(actions).toEqual(["DELETE"])
  // Nothing is enrolled any more, so the Advanced rows that need an enrollment are gone.
  await setup.waitForFrame(
    (frame) => !frame.includes("forget all phones and credentials") && !frame.includes("Forget all phones"),
  )
})

test("a TUI attached from another computer sees status only", async () => {
  await using temporary = await tmpdir()
  await using setup = await createAppFixture({
    state: temporary.path,
    fetch: (url) => {
      if (url.pathname === "/api/remote") return json(ready)
      if (url.pathname === "/api/remote/companion") return json({ running: true, origin, port: 43123, pending: [] })
      if (url.pathname === "/api/remote/tunnel") return json({ enabled: true, origin, state: "ready" })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/RC"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor != null)
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame(
    (frame) => frame.includes("Manage remote access on the host computer") && frame.includes("Phones: ready"),
  )
  const frame = setup.captureCharFrame()
  expect(frame).toContain(`Phones: ready — ${origin}`)
  expect(frame).toContain("Computers: off")
  expect(frame).not.toContain("Turn off phone access")
  expect(frame).not.toContain("Turn on computer access")
})

test("dialog title uses ready and unavailable colors and state guidance", async () => {
  await using temporary = await tmpdir()
  let status: RemoteControl.Status = ready
  await using setup = await createAppFixture({
    state: temporary.path,
    service: managed(temporary.path),
    fetch: (url) => {
      if (url.pathname === "/api/remote") return json(status)
      if (url.pathname === "/api/remote/companion") return json({ running: true, origin, port: 43123, pending: [] })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/RC"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor != null)
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("No phone yet"))
  const title = () =>
    setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text === status.state)?.fg
  const readyColor = title()
  expect(readyColor).toBeDefined()
  status = { ...status, state: "unavailable" }
  setup.events.emit({ id: "evt_remote", created: 1, type: "remote.status", data: status })
  await setup.waitForFrame((frame) => frame.includes("Companion starting"))
  expect(title()?.equals(readyColor)).toBe(false)
})

test.each(["unsupported", "identity", "unknown"] as const)(
  "dialog explains %s without offering unusable actions",
  async (state) => {
    await using temporary = await tmpdir()
    const status: RemoteControl.Status = {
      supported: state !== "unsupported",
      enabled: false,
      enrolled: false,
      state: "disabled",
      processID: "process",
      version: 1,
      leaseSeconds: 30,
    }
    await using setup = await createAppFixture({
      state: temporary.path,
      service: managed(temporary.path),
      fetch: (url) =>
        url.pathname === "/api/remote"
          ? state === "unknown"
            ? new Response(null, { status: 503 })
            : json(status)
          : undefined,
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("/ commands"), { maxPasses: 200 })
    await setup.mockInput.typeText("/remote")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) =>
      frame.includes(
        state === "unknown"
          ? "status unknown"
          : state === "identity"
            ? "Backend identity"
            : "Requires a managed service",
      ),
    )
    expect(setup.captureCharFrame()).not.toContain("Forget all phones")
    if (state === "unsupported") expect(setup.captureCharFrame()).not.toContain("Turn on phone access")
  },
)
