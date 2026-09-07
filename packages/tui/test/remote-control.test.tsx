import { expect, test } from "bun:test"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import { remoteLabel } from "../src/context/remote-control"
import { RemoteControl } from "@opencode-ai/schema/remote-control"

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
  await setup.waitForFrame((frame) => frame.includes("Disable remote control"))
  expect(setup.captureCharFrame()).not.toContain("Enable remote control")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Restart persistence was NOT updated"))
  expect(actions).toEqual(["PUT"])
  expect(setup.captureCharFrame()).toContain("disabled")
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

test("enable prompts for detected origin, configures, then enables", async () => {
  await using temporary = await tmpdir()
  using environment = companionEnvironment(temporary.path)
  const actions: string[] = []
  let companion: RemoteControl.Companion = { running: false, port: 43123, pending: [] }
  let status: RemoteControl.Status = {
    supported: true,
    enabled: false,
    enrolled: true,
    state: "disabled",
    backendID: "fixture",
    processID: "process",
    version: 1,
    leaseSeconds: 30,
  }
  await using setup = await createAppFixture({
    state: temporary.path,
    width: 140,
    fetch: async (url, request) => {
      if (url.pathname === "/api/remote") return json(status)
      if (url.pathname === "/api/remote/companion") {
        if (request.method === "PUT") {
          const config = Schema.decodeUnknownSync(RemoteControl.CompanionConfig)(await request.json())
          actions.push(`configure:${config.origin}`)
          companion = { ...companion, ...config }
        }
        return json(companion)
      }
      if (url.pathname === "/api/remote/tailscale")
        return json({ host: "fixture.ts.net", origin: "https://fixture.ts.net", certificate: true, mapping: "ready" })
      if (url.pathname === "/api/remote/policy") {
        actions.push("enable")
        status = { ...status, enabled: true, state: "unavailable" }
        return json({ status, persisted: true })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/ commands"), { maxPasses: 200 })
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Enable remote control"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Companion origin") && frame.includes("https://fixture.ts.net"))
  expect(actions).toEqual([])
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Disable remote control"))
  expect(actions).toEqual(["configure:https://fixture.ts.net", "enable"])
})

test.each(["success", "registered"] as const)(
  "phone registration %s reports the local approval flow",
  async (outcome) => {
    await using temporary = await tmpdir()
    using environment = companionEnvironment(temporary.path)
    const actions: string[] = []
    await using setup = await createAppFixture({
      state: temporary.path,
      width: 180,
      height: 60,
      fetch: (url, request) => {
        if (url.pathname === "/api/remote")
          return json({
            supported: true,
            enabled: true,
            enrolled: true,
            state: "ready",
            backendID: "fixture",
            processID: "process",
            version: 1,
            leaseSeconds: 30,
          })
        if (url.pathname === "/api/remote/companion")
          return json({ running: true, origin: "https://fixture.ts.net", port: 43123, pending: [] })
        if (url.pathname === "/api/remote/tailscale")
          return json({ host: "fixture.ts.net", origin: "https://fixture.ts.net", certificate: true, mapping: "ready" })
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
    await setup.mockInput.typeText("/remote")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Register a phone"))
    for (let i = 0; i < 4; i++) setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) =>
      frame.includes(
        outcome === "registered"
          ? "An owner passkey is already registered"
          : "within five minutes and choose Register this device",
      ),
    )
    expect(actions).toEqual(["POST"])
    if (outcome === "success") {
      await setup.renderOnce()
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => !frame.includes("Cancel phone registration"))
      expect(actions).toEqual(["POST", "DELETE"])
    }
  },
)

test.each(["missing", "conflict", "ready"] as const)(
  "phone approvals and Tailscale %s stay local and confirmed",
  async (mapping) => {
    await using temporary = await tmpdir()
    using environment = companionEnvironment(temporary.path)
    let approved = 0
    let applied = 0
    let inspected = 0
    let companion: RemoteControl.Companion = {
      running: true,
      origin: "https://fixture.ts.net",
      port: 43123,
      pending: [{ requestID: "fixture-request", fingerprint: "ABCD-EFGH" }],
    }
    let tailscale: RemoteControl.Tailscale = {
      host: "fixture.ts.net",
      origin: "https://fixture.ts.net",
      certificate: mapping !== "conflict",
      mapping,
    }
    const status: RemoteControl.Status = {
      supported: true,
      enabled: true,
      enrolled: true,
      state: "ready",
      backendID: "fixture",
      processID: "process",
      version: 1,
      leaseSeconds: 30,
    }
    await using setup = await createAppFixture({
      state: temporary.path,
      width: 160,
      height: 60,
      fetch: async (url, request) => {
        if (url.pathname === "/api/remote") return json(status)
        if (url.pathname === "/api/remote/companion") return json(companion)
        if (url.pathname === "/api/remote/tailscale") {
          if (request.method === "POST") {
            applied++
            tailscale = { ...tailscale, mapping: "ready" }
          } else inspected++
          return json(tailscale)
        }
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
    expect(inspected).toBe(0)
    await setup.mockInput.typeText("/remote")
    setup.mockInput.pressEnter()
    await setup.waitForFrame(
      (frame) => frame.includes("Approve phone ABCD-EFGH") && frame.includes("Inspect Tailscale Serve"),
    )
    expect(applied).toBe(0)
    expect(inspected).toBe(1)
    for (let i = 0; i < 5; i++) setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Confirm: approve ABCD-EFGH"))
    expect(approved).toBe(0)
    expect(setup.captureCharFrame()).toContain("must match the phone screen exactly")
    setup.mockInput.pressEnter()
    await setup.waitFor(() => approved === 1)
    await setup.waitForFrame((frame) => !frame.includes("Approve phone ABCD-EFGH"))
    await setup.renderOnce()
    if (mapping === "missing") {
      setup.mockInput.pressArrow("up")
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) =>
        frame.includes("Confirm: tailscale serve --bg --https=443 http://127.0.0.1:43123"),
      )
      expect(applied).toBe(0)
      setup.mockInput.pressEnter()
      await setup.waitForFrame(
        (frame) => !frame.includes("Map Tailscale Serve") && !frame.includes("Confirm: tailscale"),
      )
      expect(applied).toBe(1)
    } else {
      expect(setup.captureCharFrame()).not.toContain("Map Tailscale Serve to the companion")
      if (mapping === "conflict") {
        expect(setup.captureCharFrame()).toContain("inspect tailscale serve status")
        expect(setup.captureCharFrame()).toContain(
          "Enable HTTPS certificates: https://tailscale.com/kb/1153/enabling-https",
        )
      }
    }
  },
)

test.each(["success", "conflict", "network"] as const)(
  "enrollment %s is private and store-first",
  async (outcome) => {
    await using temporary = await tmpdir()
    using environment = companionEnvironment(temporary.path)
    const file = path.join(temporary.path, "redsun-remote-control", "backend.json")
    let issued = 0
    let handoff: RemoteControl.Handoff | undefined
    let status: RemoteControl.Status = {
      supported: true,
      enabled: false,
      enrolled: false,
      state: "disabled",
      backendID: "fixture",
      processID: "process",
      version: 1,
      leaseSeconds: 30,
    }
    await using setup = await createAppFixture({
      width: 180,
      height: 60,
      state: temporary.path,
      service: {
        registration: path.join(temporary.path, "service.json.remote"),
        reconnect: async () => {
          throw new Error("Unexpected reconnect")
        },
        restart: async () => {
          throw new Error("Unexpected restart")
        },
      },
      fetch: async (url, request) => {
        if (url.pathname === "/api/remote") return json(status)
        if (url.pathname !== "/api/remote/enrollment") return undefined
        issued++
        handoff = Schema.decodeUnknownSync(Schema.fromJsonString(RemoteControl.Handoff))(await readFile(file, "utf8"))
        const body = Schema.decodeUnknownSync(RemoteControl.Enrollment)(await request.json())
        expect(body.backendID).toBe("fixture")
        expect(body.credentialID).toBe(handoff.credentialID)
        expect(body.digest === createHash("sha256").update(handoff.token).digest("hex")).toBe(true)
        expect(handoff.registration).toBe(path.join(temporary.path, "service.json.remote"))
        if (outcome === "conflict") return new Response(null, { status: 409 })
        if (outcome === "network") return new Response(null, { status: 503 })
        status = { ...status, enrolled: true }
        return new Response(null, { status: 204 })
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("/ commands"), { maxPasses: 200 })
    await setup.mockInput.typeText("/remote")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Enroll a companion"))
    expect(setup.captureCharFrame()).toContain("Enable remote control")
    expect(setup.captureCharFrame()).not.toContain("Revoke companion credentials")
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Confirm: enroll a companion on this host"))
    expect(issued).toBe(0)
    expect(await Bun.file(file).exists()).toBe(false)
    setup.mockInput.pressEnter()
    await setup.waitForFrame(
      (frame) => frame.includes(outcome === "success" ? "Change companion origin" : "Enrollment not confirmed"),
      { maxPasses: 500 },
    )
    expect(issued).toBe(1)
    expect(handoff !== undefined).toBe(true)
    if (handoff) {
      const frame = setup.captureCharFrame()
      expect(frame.includes(handoff.token)).toBe(false)
      expect(frame.includes(createHash("sha256").update(handoff.token).digest("hex"))).toBe(false)
      expect((await readFile(file, "utf8")).includes(handoff.token)).toBe(true)
    }
    if (outcome === "success") {
      const frame = setup.captureCharFrame()
      for (const line of [
        "Enable remote control so the companion can attach.",
        "Change companion origin",
        "Companion-reported status; not a Tailscale connectivity test.",
      ])
        expect(frame.replace(/\s/g, "")).toContain(line.replace(/\s/g, ""))
      expect(status.enabled).toBe(false)
      expect(status.enrolled).toBe(true)
    } else {
      expect(setup.captureCharFrame()).toContain("the companion store holds an unconfirmed credential")
    }
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Confirm: enroll a companion on this host"))
    expect(issued).toBe(1)
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("A companion is already enrolled on this host"), {
      maxPasses: 500,
    })
    expect(issued).toBe(1)
    expect((await readFile(file, "utf8")).includes(handoff!.token)).toBe(true)
    expect(setup.captureCharFrame().includes(handoff!.token)).toBe(false)
  },
  15_000,
)

test("dialog title uses ready and unavailable colors and state guidance", async () => {
  await using temporary = await tmpdir()
  let status: RemoteControl.Status = {
    supported: true,
    enabled: true,
    enrolled: true,
    state: "ready",
    backendID: "fixture",
    processID: "process",
    version: 1,
    leaseSeconds: 30,
  }
  await using setup = await createAppFixture({
    state: temporary.path,
    fetch: (url) => {
      if (url.pathname === "/api/remote") return json(status)
      if (url.pathname === "/api/remote/companion")
        return json({ running: true, origin: "https://fixture.ts.net", port: 43123, pending: [] })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/RC"))
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Companion attached"))
  const title = () =>
    setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text === status.state)?.fg
  const ready = title()
  expect(ready).toBeDefined()
  status = { ...status, state: "unavailable" }
  setup.events.emit({ id: "evt_remote", created: 1, type: "remote.status", data: status })
  await setup.waitForFrame((frame) => frame.includes("Companion starting"))
  expect(title()?.equals(ready)).toBe(false)
})

test("enable and confirmed revoke report persistence failures without losing navigation", async () => {
  await using temporary = await tmpdir()
  const actions: string[] = []
  let status: RemoteControl.Status = {
    supported: true,
    enabled: false,
    enrolled: true,
    state: "disabled",
    backendID: "fixture",
    processID: "process",
    version: 1,
    leaseSeconds: 30,
  }
  await using setup = await createAppFixture({
    state: temporary.path,
    fetch: (url, request) => {
      if (url.pathname === "/api/remote") return json(status)
      if (url.pathname === "/api/remote/companion")
        return json({ running: false, origin: "https://fixture.ts.net", port: 43123, pending: [] })
      if (url.pathname === "/api/remote/policy") {
        actions.push(request.method)
        status = { ...status, enabled: true, state: "unavailable" }
        return json({ status, persisted: false })
      }
      if (url.pathname === "/api/remote/enrollment") {
        actions.push(request.method)
        status = { ...status, enrolled: false }
        return json({ status, persisted: false })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("/ commands"), { maxPasses: 200 })
  await setup.mockInput.typeText("/remote")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Enable remote control"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Restart persistence was NOT updated"))
  expect(setup.captureCharFrame()).toContain("Disable remote control")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Confirm: revoke"))
  expect(actions).toEqual(["PUT"])
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Not enrolled"))
  expect(actions).toEqual(["PUT", "DELETE"])
  expect(setup.captureCharFrame()).toContain("Restart persistence was NOT updated")
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
    expect(setup.captureCharFrame()).not.toContain("Enroll a companion Creates")
    expect(setup.captureCharFrame()).not.toContain("Revoke companion credentials")
  },
)
