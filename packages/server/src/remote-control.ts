import { Context, Effect, Exit, Layer, Schema, Scope, Semaphore, Schedule } from "effect"
import {
  serveCompanion,
  inspectTailscale,
  applyServe,
  removeHandoff,
  StorageError,
  type BackendSnapshot,
  type Local,
} from "redsun-remote-control"
import { RemoteControl } from "@opencode/schema/remote-control"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { readFile, rename, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Bus } from "@opencode/core/bus"

const Stored = Schema.Struct({
  enabled: Schema.Boolean,
  backendID: Schema.String,
  credentials: Schema.Array(RemoteControl.Enrollment),
  origin: RemoteControl.Settings.fields.origin,
  port: RemoteControl.Settings.fields.port,
})
type Stored = typeof Stored.Type
const decode = Schema.decodeUnknownSync(RemoteControl.Settings)

export type CompanionHost = {
  start(options: { origin: string; port: number }): Effect.Effect<
    { local: Local; stop: Effect.Effect<void>; backend: () => BackendSnapshot | undefined },
    Error
  >
  clear: Effect.Effect<void, Error>
}
const defaultHost: CompanionHost = {
  clear: Effect.suspend(() => removeHandoff()),
  start: (options) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const stop = Scope.close(scope, Exit.void)
      const companion = yield* serveCompanion({ ...options, backend: true }).pipe(
        Scope.provide(scope),
        Effect.onError(() => stop),
      )
      return { local: companion.local, stop, backend: companion.backend }
    }).pipe(Effect.uninterruptible),
}

export class Principal extends Context.Service<Principal, { readonly id: string; readonly epoch: number }>()(
  "redsun/RemotePrincipal",
) {}

export const make = Effect.fnUntraced(function* (
  file?: string,
  publish: (status: RemoteControl.Status) => Effect.Effect<void> = () => Effect.void,
  now: () => number = () => performance.now(),
  processID = randomUUID(),
  host: CompanionHost = defaultHost,
) {
  const lock = yield* Semaphore.make(1)
  let state: Stored = { enabled: false, backendID: randomUUID(), credentials: [] }
  let durableIdentity = false
  let epoch = 0
  const leases = new Map<string, { connected: boolean; expires: number }>()
  const connections = new Set<() => void>()
  const read = async (): Promise<Record<string, unknown>> => {
    if (!file) throw new Error("Remote control requires a managed service")
    const text = await readFile(file, "utf8").catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "{}"
      throw new Error("Unable to read service configuration")
    })
    const result: unknown = JSON.parse(text)
    if (!Schema.is(Schema.Record(Schema.String, Schema.Unknown))(result))
      throw new Error("Invalid service configuration")
    return result
  }
  const persist = (next: Stored) =>
    Effect.tryPromise({
      try: async () => {
        const document = await read()
        const target = file!
        const temporary = `${target}.${randomUUID()}.tmp`
        await mkdir(path.dirname(target), { recursive: true })
        try {
          const { createPrivateFile } = await import("@opencode/util/private-file")
          await createPrivateFile(temporary, JSON.stringify({ ...document, remote_control: next }, null, 2) + "\n")
          await rename(temporary, target)
        } finally {
          await rm(temporary, { force: true })
        }
      },
      catch: () => new Error("Unable to persist remote control configuration"),
    }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
  if (file) {
    const loaded = yield* Effect.tryPromise({
      try: read,
      catch: () => new Error("Unable to load remote control policy"),
    })
    if (loaded.remote_control !== undefined) {
      const settings = yield* Effect.try({
        try: () => decode(loaded.remote_control),
        catch: () => new Error("Invalid remote control policy"),
      })
      const credentials = settings.credentials ?? []
      if (
        credentials.some((entry) => entry.backendID !== settings.backendID) ||
        new Set(credentials.map((entry) => entry.credentialID)).size !== credentials.length
      )
        return yield* Effect.fail(new Error("Invalid remote control enrollment"))
      state = {
        enabled: settings.enabled ?? false,
        backendID: settings.backendID ?? state.backendID,
        credentials,
        origin: settings.origin,
        port: settings.port,
      }
      durableIdentity = settings.backendID !== undefined || (yield* persist(state))
    } else durableIdentity = yield* persist(state)
    if (!durableIdentity) state = { ...state, enabled: false }
  }
  const invalidate = () => {
    epoch++
    leases.clear()
    for (const close of connections) close()
    connections.clear()
  }
  let hosted: Effect.Success<ReturnType<CompanionHost["start"]>> | undefined
  let error: string | undefined
  const port = () => state.port ?? 43123
  const stop = Effect.gen(function* () {
    const previous = hosted
    hosted = undefined
    error = undefined
    if (previous) yield* previous.stop
  })
  const start = Effect.gen(function* () {
    if (hosted || !file || !state.enabled || !state.origin) return
    yield* host.start({ origin: state.origin, port: port() }).pipe(
      Effect.match({
        onSuccess: (value) => {
          hosted = value
          error = undefined
        },
        onFailure: (failure) => {
          error =
            failure instanceof StorageError
              ? "Companion is not enrolled on this host; enroll a companion first"
              : failure.message
        },
      }),
    )
  })
  const stopped = (snapshot: BackendSnapshot | undefined) => {
    if (snapshot?.state !== "stopped") return undefined
    if (snapshot.reason === "refused")
      return "This backend rejected the companion credential; revoke companion credentials and enroll a companion again"
    return `Companion stopped (${snapshot.reason}); check the service log and re-enable remote control`
  }
  const view = Effect.gen(function* (): Effect.fn.Return<RemoteControl.Companion> {
    const pending = hosted ? yield* hosted.local.pending.pipe(Effect.orElseSucceed(() => [])) : []
    return { running: hosted !== undefined, error: error ?? stopped(hosted?.backend()), origin: state.origin, port: port(), pending }
  })
  const localAction = <A>(action: (local: Local) => Effect.Effect<A, Error>) =>
    lock
      .withPermits(1)(
        Effect.suspend(() => (hosted ? action(hosted.local) : Effect.fail(new Error("Companion is not running")))),
      )
      .pipe(Effect.uninterruptible)
  yield* Effect.addFinalizer(() => lock.withPermits(1)(Effect.sync(invalidate).pipe(Effect.andThen(stop))))
  yield* start.pipe(Effect.uninterruptible)
  const status = (): RemoteControl.Status => {
    const live = [...leases.values()].filter((lease) => lease.expires > now())
    return {
      supported: file !== undefined,
      enabled: state.enabled,
      state: !state.enabled
        ? "disabled"
        : live.length === 0
          ? "unavailable"
          : live.some((lease) => lease.connected)
            ? "connected"
            : "ready",
      enrolled: state.credentials.length > 0,
      backendID: durableIdentity ? state.backendID : undefined,
      processID,
      version: RemoteControl.Version,
      leaseSeconds: RemoteControl.LeaseSeconds,
    }
  }
  const current = (principal: { id: string; epoch: number }) =>
    state.enabled && epoch === principal.epoch && state.credentials.some((entry) => entry.credentialID === principal.id)
  let previous = ""
  yield* Effect.gen(function* () {
    const value = status()
    const key = JSON.stringify(value)
    if (key === previous) return
    previous = key
    yield* publish(value)
  }).pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped)
  return {
    status,
    companion: () => lock.withPermits(1)(view),
    configure: (config: RemoteControl.CompanionConfig) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const origin = yield* Effect.try({
              try: () => {
                const parsed = new URL(config.origin)
                if (
                  parsed.protocol !== "https:" ||
                  parsed.username ||
                  parsed.password ||
                  parsed.pathname !== "/" ||
                  parsed.search ||
                  parsed.hash ||
                  !/^https:\/\/[^/?#]+\/?$/.test(config.origin)
                )
                  throw new Error()
                Schema.decodeUnknownSync(RemoteControl.CompanionConfig)(config)
                return parsed.origin
              },
              catch: () =>
                new Error(
                  "Companion origin must be an https origin without a path or credentials; port must be an integer from 1 to 65535",
                ),
            })
            const next = { ...state, origin, port: config.port ?? port() }
            if (!(yield* persist(next)))
              return yield* Effect.fail(new Error("Unable to persist companion configuration"))
            const changed = state.origin !== next.origin || port() !== next.port
            state = next
            durableIdentity = true
            if (changed) yield* stop
            yield* start
            return yield* view
          }),
        )
        .pipe(Effect.uninterruptible),
    registration: { open: localAction((local) => local.open), cancel: localAction((local) => local.cancel) },
    approve: (requestID: string, fingerprint: string) => localAction((local) => local.approve(requestID, fingerprint)),
    tailscale: {
      inspect: lock.withPermits(1)(Effect.suspend(() => inspectTailscale(port()))),
      apply: lock.withPermits(1)(Effect.suspend(() => applyServe(port()))),
    },
    authenticate(header: string) {
      const match = /^Bearer rc1\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(header)
      if (!match || !state.enabled) return undefined
      const credential = state.credentials.find((entry) => entry.credentialID === match[1])
      if (!credential) return undefined
      const digest = createHash("sha256").update(match[2]).digest()
      if (!timingSafeEqual(digest, Buffer.from(credential.digest, "hex"))) return undefined
      return { id: credential.credentialID, epoch }
    },
    current,
    connect(principal: { id: string; epoch: number }, close: () => void) {
      if (!current(principal)) {
        close()
        return () => {}
      }
      connections.add(close)
      return () => {
        connections.delete(close)
      }
    },
    heartbeat(principal: { id: string; epoch: number }, connected: boolean) {
      if (!current(principal)) return false
      leases.set(principal.id, { connected, expires: now() + RemoteControl.LeaseSeconds * 1000 })
      return true
    },
    policy: (enabled: boolean) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            if (!file) return { status: status(), persisted: false }
            if (!enabled) {
              state = { ...state, enabled: false }
              invalidate()
              yield* stop
            }
            const next = { ...state, enabled }
            const persisted = yield* persist(next)
            if (persisted) {
              state = next
              durableIdentity = true
            }
            if (enabled) yield* start
            return { status: status(), persisted }
          }),
        )
        .pipe(Effect.uninterruptible),
    enroll: (input: typeof RemoteControl.Enrollment.Type) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            if (!file || !durableIdentity || input.backendID !== state.backendID) return false
            const existing = state.credentials.find((entry) => entry.credentialID === input.credentialID)
            if (existing) {
              if (existing.digest !== input.digest) return false
              yield* stop
              yield* start
              return true
            }
            if (state.credentials.length >= 8) return false
            const next = { ...state, credentials: [...state.credentials, input] }
            if (!(yield* persist(next))) return false
            state = next
            yield* stop
            yield* start
            return true
          }),
        )
        .pipe(Effect.uninterruptible),
    revoke: lock
      .withPermits(1)(
        Effect.gen(function* () {
          state = { ...state, credentials: [] }
          yield* stop
          yield* host.clear.pipe(Effect.ignore)
          invalidate()
          const persisted = file ? yield* persist(state) : false
          if (!persisted) state = { ...state, enabled: false }
          return { status: status(), persisted }
        }),
      )
      .pipe(Effect.uninterruptible),
  }
})

export class Service extends Context.Service<Service, Effect.Success<ReturnType<typeof make>>>()(
  "redsun/RemoteControl",
) {}
export const layer = (file?: string, processID?: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return yield* make(
        file,
        (status) => bus.publish(RemoteControl.Changed, status).pipe(Effect.asVoid),
        undefined,
        processID,
      )
    }),
  )
export * as RemoteService from "./remote-control"
