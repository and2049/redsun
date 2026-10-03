import { expect, test } from "bun:test"
import { model, renderLocal, session } from "../fixture/local"
import { json } from "../fixture/tui-client"

// REDSUN: the session's worker model lives on the server behind the worker-model RPC. The TUI
// mirrors it, writes a choice straight through (in order), and offers its own default only to a
// session nobody has chosen for -- an atomic server-side `ifUnset`.

type Stored = { model?: string; revision: number }
type SetInput = { sessionID: string; model?: string; ifUnset?: boolean }

/** A worker-model server like core's: revisions, `ifUnset`, and a `changed` echo per write. */
function workerServer(initial: Record<string, { model?: string }> = {}) {
  const stored = new Map<string, Stored>(Object.entries(initial).map(([id, value]) => [id, { ...value, revision: 1 }]))
  const sets: SetInput[] = []
  let hold: Promise<void> | undefined
  let echo: ((sessionID: string, choice: { chosen: boolean; model?: string; revision: number }) => void) | undefined
  const choice = (sessionID: string) => {
    const value = stored.get(sessionID)
    return value === undefined ? { chosen: false, revision: 0 } : { chosen: true, ...value }
  }
  const handler = async (url: URL, request: Request) => {
    const match = url.pathname.match(/^\/api\/rpc\/redsun\.worker-model\/(get|set)$/)
    if (!match) return
    const { input } = (await request.json()) as { input: SetInput }
    if (match[1] === "set") {
      sets.push(input)
      await hold
      if (!(input.ifUnset && stored.has(input.sessionID))) {
        const revision = (stored.get(input.sessionID)?.revision ?? 0) + 1
        stored.set(input.sessionID, input.model === undefined ? { revision } : { model: input.model, revision })
        echo?.(input.sessionID, choice(input.sessionID))
      }
    }
    return json({ output: choice(input.sessionID) })
  }
  return {
    stored,
    sets,
    handler,
    /** Delivers each write's `changed` event through `emit` (e.g. the fixture's event stream). */
    echo(emit: typeof echo) {
      echo = emit
    },
    /** Writes as another client would: stored, then announced. */
    write(sessionID: string, model?: string) {
      const revision = (stored.get(sessionID)?.revision ?? 0) + 1
      stored.set(sessionID, model === undefined ? { revision } : { model, revision })
      echo?.(sessionID, choice(sessionID))
    },
    /** Holds every `set` until the returned release is called. */
    hold() {
      let release!: () => void
      hold = new Promise((resolve) => (release = resolve))
      return () => {
        hold = undefined
        release()
      }
    },
  }
}

const until = async (ready: () => boolean) => {
  const started = Date.now()
  while (!ready()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out")
    await Bun.sleep(10)
  }
}

async function open(server: ReturnType<typeof workerServer>, worker?: { providerID: string; modelID: string }) {
  const setup = await renderLocal({
    models: [model("first"), model("second", ["high"])],
    sessions: [session("ses_a"), session("ses_b")],
    preferences: worker ? { worker } : {},
    fetch: server.handler,
  })
  await setup.data.session.sync("ses_a")
  await setup.data.session.sync("ses_b")
  server.echo((sessionID, choice) => setup.events.emit(changed(sessionID, choice)))
  setup.route.navigate({ type: "session", sessionID: "ses_a" })
  return setup
}

let events = 0
const changed = (sessionID: string, choice: { chosen: boolean; model?: string; revision: number }) =>
  ({
    id: `evt_worker_${++events}`,
    created: 1,
    type: "rpc.redsun.worker-model.changed",
    data: { sessionID, ...choice },
  }) as never

test("shows the session's server-side worker model over the TUI default, which sync leaves alone", async () => {
  const server = workerServer({ ses_a: { model: "provider/second#high" } })
  await using setup = await open(server, { providerID: "provider", modelID: "first" })
  await until(() => setup.local.model.worker.current()?.modelID === "second")
  expect(setup.local.model.worker.ref()).toBe("provider/second#high")
  await setup.local.model.worker.sync("ses_a")
  expect(server.stored.get("ses_a")).toEqual({ model: "provider/second#high", revision: 1 })
})

test("offers the TUI default before a prompt only to a session nobody has chosen for", async () => {
  const server = workerServer()
  await using setup = await open(server, { providerID: "provider", modelID: "first" })
  await setup.local.model.worker.sync("ses_b")
  expect(server.sets).toEqual([{ sessionID: "ses_b", model: "provider/first", ifUnset: true }])
  expect(server.stored.get("ses_b")).toEqual({ model: "provider/first", revision: 1 })
})

test("a cleared session keeps the configured default across later prompts", async () => {
  const server = workerServer({ ses_a: { model: "provider/second" } })
  await using setup = await open(server, { providerID: "provider", modelID: "first" })
  await until(() => setup.local.model.worker.current()?.modelID === "second")
  // The worker_model tool's "Use the configured default".
  server.write("ses_a")
  await until(() => setup.local.model.worker.current() === undefined)
  await setup.local.model.worker.sync("ses_a")
  expect(server.stored.get("ses_a")).toEqual({ revision: 2 })
  expect(setup.local.model.worker.current()).toBeUndefined()
})

test("a choice shows at once, so the variant picker lists the new model's variants", async () => {
  const server = workerServer({ ses_a: { model: "provider/first" } })
  await using setup = await open(server)
  await until(() => setup.local.model.worker.current()?.modelID === "first")
  const release = server.hold()
  setup.local.model.worker.set({ providerID: "provider", modelID: "second" })
  expect(setup.local.model.worker.current()?.modelID).toBe("second")
  expect(setup.local.model.worker.variants()).toEqual(["high"])
  release()
  await until(() => server.stored.get("ses_a")?.model === "provider/second")
})

test("an older write's reply and echo never replace a newer choice still being written", async () => {
  const server = workerServer()
  await using setup = await open(server)
  const release = server.hold()
  setup.local.model.worker.set({ providerID: "provider", modelID: "first" })
  setup.local.model.worker.set({ providerID: "provider", modelID: "second", variant: "high" })
  release()
  const seen = new Set<string | undefined>()
  const started = Date.now()
  while (server.stored.get("ses_a")?.model !== "provider/second#high" && Date.now() - started < 2_000) {
    seen.add(setup.local.model.worker.ref())
    await Bun.sleep(1)
  }
  await Bun.sleep(30)
  expect([...seen]).toEqual(["provider/second#high"])
  expect(setup.local.model.worker.ref()).toBe("provider/second#high")
  expect(server.sets.map((input) => input.model)).toEqual(["provider/first", "provider/second#high"])
})

test("a prompt waits for a pending choice before offering the default", async () => {
  const server = workerServer()
  await using setup = await open(server, { providerID: "provider", modelID: "first" })
  const release = server.hold()
  setup.local.model.worker.set({ providerID: "provider", modelID: "second" })
  let synced = false
  const sync = setup.local.model.worker.sync("ses_a").then(() => (synced = true))
  await Bun.sleep(50)
  expect(synced).toBe(false)
  release()
  await sync
  expect(server.stored.get("ses_a")).toEqual({ model: "provider/second", revision: 1 })
})

test("another client's newer choice wins over an older read or reply", async () => {
  const server = workerServer()
  await using setup = await open(server)
  const release = server.hold()
  setup.local.model.worker.set({ providerID: "provider", modelID: "first" })
  release()
  await until(() => server.stored.get("ses_a")?.model === "provider/first")
  server.write("ses_a", "provider/second")
  await until(() => setup.local.model.worker.current()?.modelID === "second")
  // A stale snapshot (an older revision) arriving late is ignored.
  setup.events.emit(changed("ses_a", { chosen: true, model: "provider/first", revision: 1 }))
  await Bun.sleep(30)
  expect(setup.local.model.worker.current()?.modelID).toBe("second")
})

test("remembering a default for a form's answer writes no session", async () => {
  const server = workerServer()
  await using setup = await open(server)
  setup.local.model.worker.remember({ providerID: "provider", modelID: "second" })
  await Bun.sleep(20)
  expect(server.sets).toEqual([])
  expect(setup.local.model.worker.current()?.modelID).toBe("second")
})

test("an unreadable choice stays unknown and writes nothing", async () => {
  const server = workerServer()
  await using setup = await renderLocal({
    models: [model("first")],
    sessions: [session("ses_a")],
    preferences: { worker: { providerID: "provider", modelID: "first" } },
    fetch: async (url, request) =>
      url.pathname.endsWith("/get") ? new Response("down", { status: 500 }) : server.handler(url, request),
  })
  await setup.data.session.sync("ses_a")
  setup.route.navigate({ type: "session", sessionID: "ses_a" })
  await Bun.sleep(50)
  expect(server.sets).toEqual([])
  expect(setup.local.model.worker.current()?.modelID).toBe("first")
})

test("a failed choice falls back to the server's and reports the error", async () => {
  const server = workerServer({ ses_a: { model: "provider/first" } })
  await using setup = await renderLocal({
    models: [model("first"), model("second")],
    sessions: [session("ses_a")],
    fetch: async (url, request) =>
      url.pathname.endsWith("/set")
        ? json({ type: "invalid_model", message: "No such model", data: { model: "x" } }, { status: 400 })
        : server.handler(url, request),
  })
  await setup.data.session.sync("ses_a")
  setup.route.navigate({ type: "session", sessionID: "ses_a" })
  await until(() => setup.local.model.worker.current()?.modelID === "first")
  setup.local.model.worker.set({ providerID: "provider", modelID: "second" })
  expect(setup.local.model.worker.current()?.modelID).toBe("second")
  await until(() => setup.local.model.worker.current()?.modelID === "first")
})

test("a deleted session drops late worker-model replies and events", async () => {
  const server = workerServer()
  await using setup = await open(server)
  const release = server.hold()
  setup.local.model.worker.set({ providerID: "provider", modelID: "second" })
  setup.events.emit({
    id: "evt_deleted",
    created: 1,
    type: "session.deleted",
    durable: { aggregateID: "ses_a", seq: 1, version: 2 },
    data: { sessionID: "ses_a" },
  } as never)
  release()
  await until(() => server.stored.has("ses_a"))
  server.write("ses_a", "provider/first")
  await Bun.sleep(50)
  // Only the TUI default (the last choice) shows; nothing the server says about ses_a applies.
  expect(setup.local.model.worker.current()?.modelID).toBe("second")
})
