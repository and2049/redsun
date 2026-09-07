import { expect, test } from "bun:test"
import { Effect, Schema, Logger, References } from "effect"
import { RemoteControl } from "@opencode-ai/schema/remote-control"
import { Session } from "@opencode-ai/schema/session"
import { HttpServer } from "effect/unstable/http"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import type { BackendSnapshot } from "redsun-remote-control"
import { RemoteService } from "../src/remote-control"
import { RemoteAccess } from "../src/remote-access"
import { ServerProcess } from "../src/process"
import { DEFAULT_THEMES } from "@opencode-ai/theme/tui"
import { StorageError } from "redsun-remote-control"

const token = randomBytes(32).toString("base64url")
const credentialID = randomBytes(16).toString("hex")
const digest = createHash("sha256").update(token).digest("hex")
const bearer = `Bearer rc1.${credentialID}.${token}`
const local = `Basic ${btoa("opencode:fixture-password")}`
const decodeStatus = Schema.decodeUnknownSync(RemoteControl.Status)
const decodeTheme = Schema.decodeUnknownSync(RemoteControl.Theme)
const decodeSession = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.toEncoded(Session.Info) }))
const decodeIdentity = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }))
const decodePermission = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Struct({ id: Schema.String, effect: Schema.String }) }),
)
const logs: unknown[] = []
const captureLogs = Logger.layer(
  [
    Logger.make<unknown, void>((entry) => {
      logs.push(entry.message, entry.fiber.getRef(References.CurrentLogAnnotations))
    }),
  ],
  { mergeWithExisting: false },
)

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

test("managed companion starts, restarts, stops and round-trips settings without credentials in its view", async () => {
  await using dir = await tmpdir()
  using environment = companionEnvironment(dir.path)
  const file = path.join(dir.path, "service.json")
  const calls: unknown[] = []
  const pending = [{ requestID: "request", fingerprint: "ABCD-EFGH" }]
  let backend: BackendSnapshot = { state: "connecting" }
  const host: RemoteService.CompanionHost = {
    clear: Effect.sync(() => {
      calls.push("clear")
    }),
    start: (options) =>
      Effect.sync(() => {
        calls.push(options)
        return {
          backend: () => backend,
          stop: Effect.sync(() => {
            calls.push("stop")
          }),
          local: {
            pending: Effect.succeed(pending),
            open: Effect.sync(() => {
              calls.push("open")
              return { lifetimeMs: 300000 }
            }),
            cancel: Effect.sync(() => {
              calls.push("cancel")
            }),
            recover: Effect.void,
            approve: (requestID, fingerprint) =>
              fingerprint !== pending[0].fingerprint
                ? Effect.fail(new Error("Fingerprint does not match"))
                : Effect.sync(() => {
                    calls.push({ requestID, fingerprint })
                  }),
          },
        }
      }),
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* RemoteService.make(file, undefined, undefined, undefined, host)
        expect(yield* service.companion()).toMatchObject({ running: false, port: 43123, pending: [] })
        yield* service.configure({ origin: "https://fixture.ts.net" })
        expect(calls).toEqual([])
        yield* service.policy(true)
        expect(calls).toEqual([{ origin: "https://fixture.ts.net", port: 43123 }])
        yield* service.policy(true)
        expect(calls.length).toBe(1)
        expect((yield* service.companion()).pending).toEqual(pending)
        yield* service.registration.open
        yield* service.approve("request", "ABCD-EFGH")
        expect((yield* service.approve("request", "WRONG").pipe(Effect.flip)).message).toBe(
          "Fingerprint does not match",
        )
        yield* service.registration.cancel
        expect(calls.slice(-3)).toEqual(["open", pending[0], "cancel"])
        yield* service.policy(false)
        expect(calls.at(-1)).toBe("stop")
        expect(yield* service.companion()).toMatchObject({ running: false, pending: [] })
        expect(yield* service.registration.open.pipe(Effect.flip)).toBeInstanceOf(Error)
        expect(yield* service.approve("request", "ABCD-EFGH").pipe(Effect.flip)).toBeInstanceOf(Error)
        yield* service.policy(true)
        yield* service.enroll({ backendID: service.status().backendID!, credentialID, digest })
        expect(calls.slice(-2)).toEqual(["stop", { origin: "https://fixture.ts.net", port: 43123 }])
        yield* service.configure({ origin: "https://changed.ts.net", port: 43124 })
        expect(calls.slice(-2)).toEqual(["stop", { origin: "https://changed.ts.net", port: 43124 }])
        for (const origin of [
          "http://fixture.ts.net",
          "https://user:secret@fixture.ts.net",
          "https://fixture.ts.net/path",
          "https://fixture.ts.net?x=1",
        ]) {
          expect(yield* service.configure({ origin }).pipe(Effect.flip)).toBeInstanceOf(Error)
        }
        for (const port of [0, 65536, 1.5])
          expect(yield* service.configure({ origin: "https://fixture.ts.net", port }).pipe(Effect.flip)).toBeInstanceOf(
            Error,
          )
        backend = { state: "stopped", reason: "refused" }
        expect((yield* service.companion()).error).toContain("rejected the companion credential")
        backend = { state: "connecting" }
        expect((yield* service.companion()).error).toBeUndefined()
        yield* service.revoke
        expect(calls.slice(-2)).toEqual(["stop", "clear"])
        yield* service.policy(true)
      }),
    ),
  )
  expect(calls.at(-1)).toBe("stop")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* RemoteService.make(file, undefined, undefined, undefined, host)
        expect(yield* service.companion()).toMatchObject({
          running: true,
          origin: "https://changed.ts.net",
          port: 43124,
        })
      }),
    ),
  )
  const stored = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ remote_control: RemoteControl.Settings })),
  )(await readFile(file, "utf8"))
  expect(stored.remote_control).toMatchObject({ enabled: true, origin: "https://changed.ts.net", port: 43124 })
})

test("companion startup errors do not disable policy and enrollment retries startup", async () => {
  await using dir = await tmpdir()
  using environment = companionEnvironment(dir.path)
  for (const failure of [new StorageError(), new Error("Port is busy")]) {
    let attempts = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* RemoteService.make(
            path.join(dir.path, `${attempts}-${failure.name}.json`),
            undefined,
            undefined,
            undefined,
            {
              clear: Effect.void,
              start: () =>
                Effect.suspend(() => {
                  attempts++
                  return Effect.fail(failure)
                }),
            },
          )
          yield* service.configure({ origin: "https://fixture.ts.net" })
          expect((yield* service.policy(true)).status.enabled).toBe(true)
          expect(yield* service.companion()).toMatchObject({
            running: false,
            error:
              failure instanceof StorageError
                ? "Companion is not enrolled on this host; enroll a companion first"
                : "Port is busy",
          })
          yield* service.enroll({ backendID: service.status().backendID!, credentialID, digest })
          expect(attempts).toBe(2)
        }),
      ),
    )
  }
})

test("remote route and structured payload allowlists are closed", () => {
  expect(RemoteAccess.route("GET", "/api/remote/theme")).toBe(true)
  for (const method of ["POST", "PUT", "DELETE"]) expect(RemoteAccess.route(method, "/api/remote/theme")).toBe(false)
  for (const route of [
    "/api/config",
    "/api/credential",
    "/api/server",
    "/api/debug",
    "/api/fs",
    "/api/remote/policy",
    "/api/remote/enrollment",
    "/api/rpc",
    "/api/session/global/form",
  ])
    for (const method of ["GET", "POST", "PUT", "DELETE"]) expect(RemoteAccess.route(method, route)).toBe(false)
  const route = "/api/session/ses_test/prompt"
  expect(RemoteAccess.payload(route, { id: "msg_test", text: "hello" })).toBe(true)
  expect(
    RemoteAccess.payload(route, { id: "msg_test", text: "hello", files: [{ uri: "data:text/plain;base64,aGk=" }] }),
  ).toBe(true)
  for (const extra of [
    { files: [{ uri: "file:///private" }] },
    { metadata: {} },
    { skills: [] },
    { agents: [] },
    { files: [{ uri: "data:text/plain;base64,aGk=", injected: true }] },
    { resume: false },
  ])
    expect(RemoteAccess.payload(route, { id: "msg_test", text: "hello", ...extra })).toBe(false)
  expect(RemoteAccess.payload(route, { text: "missing reconciliation ID" })).toBe(false)
  expect(
    RemoteAccess.eventFrame('data: {"id":"evt_test","type":"credential.updated","data":{"secret":"fixture"}}\n\n'),
  ).toBe("")
  expect(
    RemoteAccess.eventFrame('data: {"id":"evt_test","type":"session.text.delta","data":{"secret":"fixture"}}\n\n'),
  ).toBe('data: {"id":"evt_test","created":0,"type":"remote.sync","data":{}}\n\n')
})

test("policy, enrollment and revocation persist; failed writes fail closed", async () => {
  await using dir = await tmpdir()
  const file = path.join(dir.path, "service.json")
  let backendID = ""
  let processID = ""
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* RemoteService.make(file)
        expect(service.status().state).toBe("disabled")
        backendID = service.status().backendID!
        processID = service.status().processID
        expect(yield* service.enroll({ backendID, credentialID, digest })).toBe(true)
        expect(service.authenticate(bearer)).toBeUndefined()
        expect((yield* service.policy(true)).persisted).toBe(true)
        const principal = service.authenticate(bearer)!
        expect(principal).toBeDefined()
        service.heartbeat(principal, true)
        expect(service.status().state).toBe("connected")
        let closed = 0
        service.connect(principal, () => closed++)
        expect((yield* service.policy(false)).persisted).toBe(true)
        expect(closed).toBe(1)
        expect(service.current(principal)).toBe(false)
        expect(service.status().enrolled).toBe(true)
        yield* service.policy(true)
      }),
    ),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* RemoteService.make(file)
        expect(service.status()).toMatchObject({ backendID, enabled: true, state: "unavailable", enrolled: true })
        expect(service.status().processID).not.toBe(processID)
        expect(service.authenticate(bearer)).toBeDefined()
        yield* Effect.promise(() => rename(file, `${file}.saved`))
        yield* Effect.promise(() => mkdir(file))
        const disabled = yield* service.policy(false)
        expect(disabled).toMatchObject({ persisted: false, status: { enabled: false } })
        expect(yield* service.policy(true)).toMatchObject({ persisted: false, status: { enabled: false } })
        expect(service.authenticate(bearer)).toBeUndefined()
        yield* Effect.promise(() => rm(file, { recursive: true }))
        yield* Effect.promise(() => rename(`${file}.saved`, file))
        expect((yield* service.revoke).persisted).toBe(true)
        yield* service.policy(true)
      }),
    ),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* RemoteService.make(file)
        expect(service.authenticate(bearer)).toBeUndefined()
        expect(service.status().enrolled).toBe(false)
      }),
    ),
  )
  expect(await readFile(file, "utf8")).not.toContain(token)
})

test("leases expire independently, stale principals cannot report, and unmanaged policy cannot enable", async () => {
  await using dir = await tmpdir()
  let now = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const unmanaged = yield* RemoteService.make()
        expect(yield* unmanaged.policy(true)).toMatchObject({
          persisted: false,
          status: { supported: false, enabled: false },
        })
        const service = yield* RemoteService.make(path.join(dir.path, "service.json"), undefined, () => now)
        yield* service.enroll({ backendID: service.status().backendID!, credentialID, digest })
        yield* service.policy(true)
        const principal = service.authenticate(bearer)!
        expect(service.heartbeat(principal, true)).toBe(true)
        now = 29_999
        expect(service.status().state).toBe("connected")
        now = 30_000
        expect(service.status().state).toBe("unavailable")
        expect(service.heartbeat({ ...principal, id: "other" }, true)).toBe(false)
        service.heartbeat(principal, false)
        expect(service.status().state).toBe("ready")
        yield* service.policy(false)
        yield* service.policy(true)
        expect(service.heartbeat(principal, true)).toBe(false)
        expect(service.status().state).toBe("unavailable")
      }),
    ),
  )
})

it.live(
  "scoped theme reads global CLI selection and custom files afresh, with safe fallback and admission",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const server = yield* ServerProcess.start<never, never>({
        hostname: "127.0.0.1",
        port: 0,
        password: "fixture-password",
        database: { path: ":memory:" },
        config: { directory: dir.path, project: false },
        models: { fetch: false },
        fs: { filewatcher: false },
        remoteControl: { file: path.join(dir.path, "service.json") },
      })
      const base = HttpServer.formatAddress(server.address)
      const request = (route: string, authorization = bearer, method = "GET", body?: unknown) =>
        Effect.promise(() =>
          fetch(base + route, {
            method,
            headers: { authorization, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
          }),
        )
      const read = (response: Response) => Effect.promise(async (): Promise<unknown> => response.json())
      const status = decodeStatus(yield* read(yield* request("/api/remote", local)))
      yield* request("/api/remote/enrollment", local, "POST", { backendID: status.backendID, credentialID, digest })
      expect((yield* request("/api/remote/theme")).status).toBe(401)
      yield* request("/api/remote/policy", local, "PUT", { enabled: true })
      expect((yield* request("/api/remote/theme", "")).status).toBe(401)
      for (const query of ["?name=dawn", "?location[directory]=ignored", "?token=ignored"])
        expect((yield* request("/api/remote/theme" + query)).status).toBe(401)
      const get = Effect.gen(function* () {
        const response = yield* request("/api/remote/theme")
        expect(response.status).toBe(200)
        return decodeTheme(yield* read(response))
      })
      const fallback = yield* get
      expect(fallback).toMatchObject({ name: "dusk", mode: "dark" })
      expect(fallback.colors.text.default).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
      expect(() =>
        decodeTheme({
          ...fallback,
          colors: { ...fallback.colors, border: { default: "red" } },
        }),
      ).toThrow()
      expect(Object.keys(fallback.colors)).toEqual(["text", "background", "border", "diff", "markdown"])
      const file = path.join(dir.path, "cli.json")
      const custom = path.join(dir.path, "themes", "fixture.json")
      yield* Effect.promise(async () => {
        await mkdir(path.dirname(custom))
        await writeFile(custom, JSON.stringify(DEFAULT_THEMES.dawn))
        await writeFile(file, '{ // CLI supports JSONC\n "theme": { "name": "fixture", }, }')
      })
      const theme = yield* get
      expect(theme).toMatchObject({ name: "fixture", mode: "light" })
      expect(theme.colors.text.default).toBe("#141414")
      expect(theme.colors.text.subdued).toBe("#141414ad")
      yield* Effect.promise(() => writeFile(custom, JSON.stringify(DEFAULT_THEMES.dusk)))
      expect(yield* get).toEqual({ ...fallback, name: "fixture" })
      for (const source of ['{"version":2}', "{broken", "null"]) {
        yield* Effect.promise(() => writeFile(custom, source))
        expect(yield* get).toEqual(fallback)
      }
      for (const name of ["missing", "../fixture", "toString", "__proto__"]) {
        yield* Effect.promise(() => writeFile(file, JSON.stringify({ theme: { name } })))
        expect(yield* get).toEqual(fallback)
      }
      yield* Effect.promise(() => writeFile(file, "{broken"))
      expect(yield* get).toEqual(fallback)
      yield* Effect.promise(async () => {
        const projectThemes = path.join(dir.path, ".redsun", "themes")
        await mkdir(projectThemes, { recursive: true })
        await writeFile(path.join(projectThemes, "project-only.json"), JSON.stringify(DEFAULT_THEMES.dawn))
        await writeFile(file, JSON.stringify({ theme: { name: "project-only" } }))
      })
      expect(yield* get).toEqual(fallback)
      yield* Effect.promise(() =>
        writeFile(path.join(dir.path, "themes", "dusk.json"), JSON.stringify(DEFAULT_THEMES.dawn)),
      )
      expect(yield* get).toMatchObject({ name: "dusk", mode: "light", colors: theme.colors })
      yield* request("/api/remote/policy", local, "PUT", { enabled: false })
      expect((yield* request("/api/remote/theme")).status).toBe(401)
    }),
  30_000,
)

it.live(
  "managed policy and credential identity survive real API restarts and project selection cannot enable RC",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const file = path.join(dir.path, "service.json")
      const project = path.join(dir.path, "project")
      yield* Effect.promise(async () => {
        await mkdir(project)
        await writeFile(path.join(project, "redsun.json"), JSON.stringify({ remote_control: { enabled: true } }))
      })
      let backendID = ""
      let processID = ""
      for (const phase of ["enable", "disable", "reenable", "revoke", "verify"] as const) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* ServerProcess.start<never, never>({
              hostname: "127.0.0.1",
              port: 0,
              password: "fixture-password",
              database: { path: ":memory:" },
              models: { fetch: false },
              fs: { filewatcher: false },
              config: { directory: dir.path, project: true },
              remoteControl: { file },
            })
            const base = HttpServer.formatAddress(server.address)
            const request = (route: string, method = "GET", body?: unknown, authorization = local) =>
              Effect.promise(() =>
                fetch(base + route, {
                  method,
                  headers: { authorization, "content-type": "application/json" },
                  body: body === undefined ? undefined : JSON.stringify(body),
                  signal: AbortSignal.timeout(5000),
                }),
              )
            const status = decodeStatus(
              yield* Effect.promise(async () =>
                (await fetch(base + "/api/remote", { headers: { authorization: local } })).json(),
              ),
            )
            if (phase === "enable") {
              backendID = status.backendID!
              expect(status.enabled).toBe(false)
              yield* request(`/api/location?location[directory]=${encodeURIComponent(project)}`)
              const selected = decodeStatus(
                yield* Effect.promise(async () =>
                  (await fetch(base + "/api/remote", { headers: { authorization: local } })).json(),
                ),
              )
              expect(selected.enabled).toBe(false)
              yield* request("/api/remote/enrollment", "POST", { backendID, credentialID, digest })
            } else {
              expect(status.backendID).toBe(backendID)
              expect(status.processID).not.toBe(processID)
              expect(status.state).not.toBe("connected")
              expect((yield* request("/api/remote", "GET", undefined, bearer)).status).toBe(
                phase === "reenable" || phase === "verify" ? 401 : 200,
              )
            }
            processID = status.processID
            if (phase === "verify") {
              yield* request("/api/remote/policy", "PUT", { enabled: true })
              expect((yield* request("/api/remote", "GET", undefined, bearer)).status).toBe(401)
            } else if (phase === "revoke") yield* request("/api/remote/enrollment", "DELETE")
            else yield* request("/api/remote/policy", "PUT", { enabled: phase !== "disable" })
          }),
        )
      }
    }),
  30_000,
)

it.live(
  "real authenticated API enforces scoped admission and closes only remote streams",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const server = yield* ServerProcess.start<never, never>({
        hostname: "127.0.0.1",
        port: 0,
        password: "fixture-password",
        database: { path: ":memory:" },
        config: { directory: dir.path, project: false },
        models: { fetch: false },
        fs: { filewatcher: false },
        remoteControl: { file: path.join(dir.path, "service.json") },
      })
      const base = HttpServer.formatAddress(server.address)
      const request = (route: string, method = "GET", body?: unknown, authorization = local) =>
        Effect.promise(() =>
          fetch(base + route, {
            method,
            headers: { authorization, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          }),
        )
      const read = (response: Response) => Effect.promise(async (): Promise<unknown> => response.json())
      const status = decodeStatus(yield* read(yield* request("/api/remote")))
      expect(status).toMatchObject({ enabled: false, supported: true, state: "disabled" })
      expect(
        (yield* request("/api/remote/enrollment", "POST", { backendID: status.backendID, credentialID, digest }))
          .status,
      ).toBe(204)
      for (const [route, method, body] of [
        ["/api/remote", "GET", undefined],
        ["/api/session", "POST", { title: "denied" }],
      ] as const)
        expect((yield* request(route, method, body, bearer)).status).toBe(401)
      expect((yield* request("/api/remote/policy", "PUT", { enabled: true })).status).toBe(200)
      expect((yield* request("/api/remote", "GET", undefined, bearer)).status).toBe(200)
      expect((yield* request("/api/remote/heartbeat", "POST", { connected: true }, bearer)).status).toBe(200)
      expect(
        (yield* request("/api/remote/heartbeat", "POST", { connected: true, principal: "other" }, bearer)).status,
      ).toBe(401)
      for (const route of ["/api/config", "/api/server", "/api/credential", "/openapi.json", "/api/new-future-route"])
        expect((yield* request(route, "GET", undefined, bearer)).status).not.toBe(200)
      expect((yield* request("/api/remote/policy", "PUT", { enabled: false }, bearer)).status).toBe(401)
      expect((yield* request("/api/remote", "GET", undefined, `Basic ${btoa(`opencode:${token}`)}`)).status).toBe(401)
      const created = decodeSession(
        yield* read(
          yield* request(
            "/api/session",
            "POST",
            { location: { directory: dir.path }, title: "Remote fixture" },
            bearer,
          ),
        ),
      )
      expect(created.data.title).toBe("Remote fixture")
      yield* request(`/api/plugin/await-activation?location[directory]=${encodeURIComponent(dir.path)}`, "POST")
      const permission = decodePermission(
        yield* read(
          yield* request(`/api/session/${created.data.id}/permission`, "POST", {
            action: "external_directory",
            resources: [path.dirname(dir.path)],
            agent: "compose",
            metadata: { fixtureSecret: "private-permission-metadata" },
          }),
        ),
      )
      expect(permission.data.effect).toBe("ask")
      const requests = yield* read(
        yield* request(`/api/session/${created.data.id}/permission`, "GET", undefined, bearer),
      )
      expect(JSON.stringify(requests)).not.toContain("private-permission-metadata")
      expect(
        (yield* request(
          `/api/session/${created.data.id}/permission/${permission.data.id}/reply`,
          "POST",
          { reply: "once" },
          bearer,
        )).status,
      ).toBe(204)
      const form = decodeIdentity(
        yield* read(
          yield* request(`/api/session/${created.data.id}/form`, "POST", {
            title: "Fixture question",
            fields: [{ type: "string", key: "choice", title: "Choose", required: true }],
            metadata: { fixtureSecret: "private-form-metadata" },
          }),
        ),
      )
      const remoteForm = yield* read(
        yield* request(`/api/session/${created.data.id}/form/${form.data.id}`, "GET", undefined, bearer),
      )
      expect(JSON.stringify(remoteForm)).not.toContain("private-form-metadata")
      expect(
        (yield* request(
          `/api/session/${created.data.id}/form/${form.data.id}/reply`,
          "POST",
          { answer: { choice: "yes" } },
          bearer,
        )).status,
      ).toBe(204)
      const external = decodeIdentity(
        yield* read(
          yield* request(`/api/session/${created.data.id}/form`, "POST", {
            title: "Local external authorization",
            fields: [{ type: "external", key: "auth", url: "https://example.invalid/?fixture-secret" }],
          }),
        ),
      )
      expect(
        (yield* request(`/api/session/${created.data.id}/form/${external.data.id}`, "GET", undefined, bearer)).status,
      ).toBe(404)
      const listedForms = yield* read(yield* request(`/api/session/${created.data.id}/form`, "GET", undefined, bearer))
      expect(JSON.stringify(listedForms)).not.toContain("fixture-secret")
      const target = path.join(dir.path, "moved")
      yield* Effect.promise(() => mkdir(target))
      expect(
        (yield* request(`/api/session/${created.data.id}/move`, "POST", { directory: target }, bearer)).status,
      ).toBe(204)
      const movedStatus = yield* read(yield* request("/api/remote"))
      expect(movedStatus).toMatchObject({ backendID: status.backendID, enabled: true })
      const spoofed = yield* Effect.promise(() =>
        fetch(base + "/api/remote", { headers: { "x-redsun-companion": "true", "x-forwarded-for": "127.0.0.1" } }),
      )
      expect(spoofed.status).toBe(401)
      expect(
        (yield* request(
          `/api/session/${created.data.id}/prompt`,
          "POST",
          { id: "msg_fixture", text: "no read", files: [{ uri: "file:///private" }] },
          bearer,
        )).status,
      ).toBe(401)
      const remote = yield* request("/api/event", "GET", undefined, bearer)
      const localStream = yield* request("/api/event")
      expect(remote.status).toBe(200)
      const closingTui = yield* request("/api/event")
      const closingTuiReader = closingTui.body!.getReader()
      yield* Effect.promise(() => closingTuiReader.read())
      yield* Effect.promise(() => closingTuiReader.cancel())
      expect((yield* request("/api/remote/heartbeat", "POST", { connected: true }, bearer)).status).toBe(200)
      expect(decodeStatus(yield* read(yield* request("/api/remote"))).enabled).toBe(true)
      const remoteReader = remote.body!.getReader()
      const localReader = localStream.body!.getReader()
      yield* Effect.promise(() => remoteReader.read())
      yield* Effect.promise(() => localReader.read())
      yield* request("/api/remote/policy", "PUT", { enabled: false })
      yield* Effect.promise(async () => {
        while (!(await remoteReader.read()).done) {}
      })
      yield* server.updateAvailable("fixture-version")
      const localChunk = yield* Effect.promise(() => localReader.read())
      expect(localChunk.done).toBe(false)
      yield* Effect.promise(() => localReader.cancel())
      expect((yield* request("/api/remote", "GET", undefined, bearer)).status).toBe(401)
      yield* request("/api/remote/policy", "PUT", { enabled: true })
      expect((yield* request("/api/remote", "GET", undefined, bearer)).status).toBe(200)
      const pendingBody = new TransformStream<Uint8Array, Uint8Array>()
      const writer = pendingBody.writable.getWriter()
      const pending = fetch(base + "/api/session", {
        method: "POST",
        headers: { authorization: bearer, "content-type": "application/json" },
        body: pendingBody.readable,
        signal: AbortSignal.timeout(5000),
      })
      yield* Effect.promise(() => writer.write(new TextEncoder().encode('{"title":"late",')))
      yield* request("/api/remote/policy", "PUT", { enabled: false })
      yield* Effect.promise(async () => {
        await writer.write(new TextEncoder().encode(`"location":{"directory":${JSON.stringify(dir.path)}}}`))
        await writer.close()
        expect((await pending).status).toBe(401)
      })
      yield* request("/api/remote/policy", "PUT", { enabled: true })
      const revokedStream = yield* request("/api/event", "GET", undefined, bearer)
      const revokedReader = revokedStream.body!.getReader()
      yield* Effect.promise(() => revokedReader.read())
      yield* request("/api/remote/enrollment", "DELETE")
      yield* Effect.promise(async () => {
        while (!(await revokedReader.read()).done) {}
      })
      expect((yield* request("/api/remote", "GET", undefined, bearer)).status).toBe(401)
      expect(JSON.stringify(logs)).not.toContain(token)
      expect(JSON.stringify(logs)).not.toContain(local)
      expect(JSON.stringify(logs)).not.toContain("fixture-password")
    }).pipe(Effect.provide(captureLogs)),
  30_000,
)
