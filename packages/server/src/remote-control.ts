import { Context, Effect, Exit, Fiber, Layer, Schema, Scope, Semaphore, Schedule } from "effect"
import {
  serveCompanion,
  removeHandoff,
  recoverBrowser,
  importHandoff,
  StorageError,
  type BackendSnapshot,
  type Local,
} from "redsun-remote-control"
import { RemoteControl } from "@opencode/schema/remote-control"
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { RemoteTunnel } from "./remote-tunnel"
import { readFile, rename, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Bus } from "@opencode/core/bus"

const Stored = Schema.Struct({
  enabled: Schema.Boolean,
  backendID: Schema.String,
  credentials: Schema.Array(RemoteControl.Enrollment),
  origin: RemoteControl.Settings.fields.origin,
  port: RemoteControl.Settings.fields.port,
  tunnel: RemoteControl.Settings.fields.tunnel,
  computers: RemoteControl.Settings.fields.computers,
})
type Stored = typeof Stored.Type
const decode = Schema.decodeUnknownSync(RemoteControl.Settings)
// Upstream's service-config key for the backend route (`opencode service set remote true`); migrated into
// `remote_control.computers` on first load.
const LegacyRoute = Schema.Struct({ route: Schema.String })

export type CompanionHost = {
  start(options: {
    origin: string
    port: number
  }): Effect.Effect<{ local: Local; stop: Effect.Effect<void>; backend: () => BackendSnapshot | undefined }, Error>
  clear: Effect.Effect<void, Error>
  /** Forgets the registered phone: its passkey is bound to the companion origin, so a new origin invalidates it. */
  reset: Effect.Effect<void, Error>
  /** Stores a freshly issued backend credential in the companion's private store (never overwrites one). */
  import(handoff: RemoteControl.Handoff): Effect.Effect<void, Error>
}
const defaultHost: CompanionHost = {
  clear: Effect.suspend(() => removeHandoff()),
  reset: Effect.suspend(() => recoverBrowser()),
  import: (handoff) =>
    Effect.suspend(() => importHandoff(handoff)).pipe(
      Effect.mapError((failure) =>
        failure instanceof StorageError
          ? new Error(
              "A companion is already enrolled on this host or its private store is unavailable; revoke companion credentials first",
            )
          : failure,
      ),
      Effect.asVoid,
    ),
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

/** The device tunnel that fronts the companion and the backend; tests supply a fake so no real tunnel is ever created. */
export type TunnelHost = {
  /** Creates the device tunnel when missing and waits for its certificate; resolves to the tunnel hostname. */
  ensure(onIssuing: () => void): Effect.Effect<string, Error>
  /** Attaches routes until interrupted; transient failures retry inside, fatal ones report through `onFailure`. */
  run(input: RemoteTunnel.Input): Effect.Effect<void>
}
const defaultTunnel: TunnelHost = {
  ensure: (onIssuing) => RemoteTunnel.ensure({ onIssuing }).pipe(Effect.mapError((error) => new Error(error.message))),
  run: (input) => RemoteTunnel.run(input),
}

/** What the server process supplies for computer access and the atomic phone enable. */
export type Environment = {
  /** The password-free discovery file a companion handoff points at (`<registration>.remote`). */
  readonly registration?: string
  /** The backend's loopback `host:port`, the target of the computers route; undefined until the server listens. */
  readonly local?: () => string | undefined
  /** Receives the public backend URL whenever the computers route attaches or drops (feeds `/api/info` `urls`). */
  readonly onComputerURLs?: (urls: ReadonlyArray<string>) => void
}

export class Principal extends Context.Service<Principal, { readonly id: string; readonly epoch: number }>()(
  "redsun/RemotePrincipal",
) {}

const ROUTE = () => randomBytes(8).toString("hex")

export const make = Effect.fnUntraced(function* (
  file?: string,
  publish: (status: RemoteControl.Status) => Effect.Effect<void> = () => Effect.void,
  now: () => number = () => performance.now(),
  processID = randomUUID(),
  host: CompanionHost = defaultHost,
  tunnel: TunnelHost = defaultTunnel,
  environment: Environment = {},
) {
  const lock = yield* Semaphore.make(1)
  const scope = yield* Effect.scope
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
        // The legacy top-level route has been folded into `computers`; writing drops it so every reader agrees.
        const { remote: _legacy, ...document } = await read()
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
    const legacy = Schema.is(LegacyRoute)(loaded.remote) ? loaded.remote.route : undefined
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
        tunnel: settings.tunnel,
        computers: settings.computers ?? (legacy === undefined ? undefined : { enabled: true, route: legacy }),
      }
      const migrated = settings.computers === undefined && legacy !== undefined
      durableIdentity = (settings.backendID !== undefined && !migrated) || (yield* persist(state))
    } else {
      if (legacy !== undefined) state = { ...state, computers: { enabled: true, route: legacy } }
      durableIdentity = yield* persist(state)
    }
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
  let issuing = false
  // Issuing the certificate takes minutes and must outlive the request that started it: a client that gives up
  // (a CLI timeout, a closed TUI) would otherwise interrupt the issuance. Requests that overlap share one.
  let issuance: Fiber.Fiber<string, Error> | undefined
  const ensureHostname = Effect.gen(function* () {
    if (issuance === undefined || issuance.pollUnsafe() !== undefined)
      issuance = yield* tunnel
        .ensure(() => {
          issuing = true
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              issuing = false
            }),
          ),
          Effect.forkIn(scope),
        )
    return yield* Fiber.join(issuance)
  })
  // One route on the device tunnel: attached on a forked fiber for as long as its owner wants it.
  const makeRoute = (input: { readonly drift: string; readonly onOrigin?: (origin: string | undefined) => void }) => {
    let attached: Fiber.Fiber<void> | undefined
    let link: { state: "attaching" | "ready" | "failed"; error?: string } = { state: "attaching" }
    let live: string | undefined
    const update = (origin: string | undefined) => {
      live = origin
      input.onOrigin?.(origin)
    }
    const stop = Effect.gen(function* () {
      const fiber = attached
      attached = undefined
      if (fiber) yield* Fiber.interrupt(fiber)
      link = { state: "attaching" }
      update(undefined)
    })
    const start = (route: string, target: string, expected: string | undefined) =>
      Effect.gen(function* () {
        // A fiber that ended (the tunnel stopped for good) is replaced; a live one is kept.
        if (attached !== undefined && attached.pollUnsafe() === undefined) return
        link = { state: "attaching" }
        attached = yield* tunnel
          .run({
            routes: { [route]: target },
            onHostname: (hostname) => {
              if (hostname === undefined) {
                link = { state: "attaching" }
                update(undefined)
                return
              }
              const origin = `https://${route}.${hostname}`
              link =
                expected === undefined || expected === origin
                  ? { state: "ready" }
                  : { state: "ready", error: input.drift }
              update(origin)
            },
            onFailure: (message) => {
              link = { state: "failed", error: message }
            },
          })
          .pipe(Effect.forkIn(scope))
      })
    const view = (enabled: boolean, origin: string | undefined): RemoteControl.Tunnel => {
      if (!enabled) return { enabled: false, state: issuing ? "issuing" : "off" }
      return {
        enabled: true,
        origin: origin ?? live,
        state: issuing ? "issuing" : attached === undefined ? "waiting" : link.state,
        error: attached === undefined ? undefined : link.error,
      }
    }
    return { stop, start, view, live: () => live }
  }
  // The companion's route runs only while the companion does; the relay has nothing to forward to otherwise.
  const phones = makeRoute({
    drift: "Tunnel hostname changed; disable and enable phone access to update the companion origin",
  })
  const computers = makeRoute({
    drift: "Tunnel hostname changed; disable and enable computer access to update the address",
    onOrigin: (origin) => environment.onComputerURLs?.(origin === undefined ? [] : [origin]),
  })
  const startPhones = Effect.suspend(() => {
    if (!hosted || !state.tunnel?.enabled) return Effect.void
    return phones.start(state.tunnel.route, `127.0.0.1:${port()}`, state.origin)
  })
  const startComputers = Effect.suspend(() => {
    const target = environment.local?.()
    if (!file || !state.computers?.enabled || target === undefined) return Effect.void
    return computers.start(state.computers.route, target, state.computers.origin)
  })
  const stop = Effect.gen(function* () {
    yield* phones.stop
    const previous = hosted
    hosted = undefined
    error = undefined
    if (previous) yield* previous.stop
  })
  const start = Effect.gen(function* () {
    if (!file || !state.enabled || !state.origin) return
    if (!hosted)
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
    yield* startPhones
  })
  const tunnelView = () => phones.view(state.tunnel?.enabled ?? false, state.origin)
  const computersView = (): RemoteControl.Computers =>
    computers.view(state.computers?.enabled ?? false, state.computers?.origin)
  const stopped = (snapshot: BackendSnapshot | undefined) => {
    if (snapshot?.state !== "stopped") return undefined
    if (snapshot.reason === "refused")
      return "This backend rejected the companion credential; revoke companion credentials and enroll a companion again"
    return `Companion stopped (${snapshot.reason}); check the service log and re-enable remote control`
  }
  const view = Effect.gen(function* (): Effect.fn.Return<RemoteControl.Companion> {
    const pending = hosted ? yield* hosted.local.pending.pipe(Effect.orElseSucceed(() => [])) : []
    return {
      running: hosted !== undefined,
      error: error ?? stopped(hosted?.backend()),
      origin: state.origin,
      port: port(),
      pending,
    }
  })
  const localAction = <A>(action: (local: Local) => Effect.Effect<A, Error>) =>
    lock
      .withPermits(1)(
        Effect.suspend(() => (hosted ? action(hosted.local) : Effect.fail(new Error("Companion is not running")))),
      )
      .pipe(Effect.uninterruptible)
  yield* Effect.addFinalizer(() =>
    lock.withPermits(1)(Effect.sync(invalidate).pipe(Effect.andThen(stop), Effect.andThen(computers.stop))),
  )
  yield* start.pipe(Effect.uninterruptible)
  yield* startComputers.pipe(Effect.uninterruptible)
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
  const policy = (enabled: boolean) =>
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
      .pipe(Effect.uninterruptible)
  const enroll = (input: typeof RemoteControl.Enrollment.Type) =>
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
      .pipe(Effect.uninterruptible)
  const configureTunnel = (config: RemoteControl.TunnelConfig) =>
    Effect.gen(function* () {
      if (!file) return yield* Effect.fail(new Error("Remote control requires a managed service"))
      if (!config.enabled)
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (state.tunnel?.enabled) {
              const next = { ...state, tunnel: { ...state.tunnel, enabled: false } }
              if (!(yield* persist(next)))
                return yield* Effect.fail(new Error("Unable to persist phone access configuration"))
              state = next
              yield* phones.stop
            }
            return tunnelView()
          }).pipe(Effect.uninterruptible),
        )
      // Issuing the certificate can take minutes, so it runs outside the lock; nothing is persisted until the
      // hostname is known, and an interrupted issuance resumes on the next attempt.
      const route = config.rotate || state.tunnel === undefined ? ROUTE() : state.tunnel.route
      const hostname = yield* ensureHostname
      const origin = `https://${route}.${hostname}`
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const next = { ...state, tunnel: { enabled: true, route }, origin }
          if (!(yield* persist(next)))
            return yield* Effect.fail(new Error("Unable to persist phone access configuration"))
          const changed = state.origin !== origin || state.tunnel?.route !== route
          // A companion that starts at a new origin with the old phone's record refuses to run, so the phone is
          // forgotten here: rotate promises exactly that, and a tunnel whose hostname changed is the same case.
          const rebound = state.origin !== undefined && state.origin !== origin
          state = next
          durableIdentity = true
          if (changed) yield* stop
          if (rebound) yield* host.reset.pipe(Effect.ignore)
          yield* start
          return tunnelView()
        }).pipe(Effect.uninterruptible),
      )
    })
  const configureComputers = (config: RemoteControl.ComputersConfig) =>
    Effect.gen(function* () {
      if (!file) return yield* Effect.fail(new Error("Remote control requires a managed service"))
      if (!config.enabled)
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if (state.computers?.enabled) {
              const next = { ...state, computers: { ...state.computers, enabled: false } }
              if (!(yield* persist(next)))
                return yield* Effect.fail(new Error("Unable to persist computer access configuration"))
              state = next
              yield* computers.stop
            }
            return computersView()
          }).pipe(Effect.uninterruptible),
        )
      const route = config.rotate || state.computers === undefined ? ROUTE() : state.computers.route
      const hostname = yield* ensureHostname
      const origin = `https://${route}.${hostname}`
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const next = { ...state, computers: { enabled: true, route, origin } }
          if (!(yield* persist(next)))
            return yield* Effect.fail(new Error("Unable to persist computer access configuration"))
          const changed = state.computers?.route !== route || state.computers.origin !== origin
          state = next
          durableIdentity = true
          if (changed) yield* computers.stop
          yield* startComputers
          return computersView()
        }).pipe(Effect.uninterruptible),
      )
    })
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
            const rebound = state.origin !== undefined && state.origin !== next.origin
            state = next
            durableIdentity = true
            if (changed) yield* stop
            if (rebound) yield* host.reset.pipe(Effect.ignore)
            yield* start
            return yield* view
          }),
        )
        .pipe(Effect.uninterruptible),
    registration: { open: localAction((local) => local.open), cancel: localAction((local) => local.cancel) },
    approve: (requestID: string, fingerprint: string) => localAction((local) => local.approve(requestID, fingerprint)),
    tunnel: {
      status: lock.withPermits(1)(Effect.sync(tunnelView)),
      configure: configureTunnel,
    },
    computers: {
      status: lock.withPermits(1)(Effect.sync(computersView)),
      configure: configureComputers,
      /** The public backend URL, once the computers route is attached. */
      origin: lock.withPermits(1)(
        Effect.suspend(() => {
          if (!state.computers?.enabled) return Effect.fail(new Error("Computer access is off"))
          const view = computersView()
          const origin = computers.live()
          if (view.state !== "ready" || origin === undefined)
            return Effect.fail(new Error(view.error ?? "Computer access is not ready yet; try again in a moment"))
          return Effect.succeed(origin)
        }),
      ),
    },
    // One call for "turn on phone access": enroll a companion when none is, create the address, enable the policy.
    enable: Effect.gen(function* () {
      if (!file) return yield* Effect.fail(new Error("Remote control requires a managed service"))
      if (state.credentials.length === 0) {
        if (!durableIdentity) return yield* Effect.fail(new Error("Backend identity has not been persisted"))
        if (environment.registration === undefined)
          return yield* Effect.fail(new Error("Managed service registration is unknown; enroll a companion manually"))
        const credentialID = randomBytes(16).toString("hex")
        const token = randomBytes(32).toString("base64url")
        yield* host.import({
          version: RemoteControl.Version,
          backendID: state.backendID,
          registration: environment.registration,
          credentialID,
          token,
        })
        const enrolled = yield* enroll({
          backendID: state.backendID,
          credentialID,
          digest: createHash("sha256").update(token).digest("hex"),
        })
        if (!enrolled) return yield* Effect.fail(new Error("Enrollment was not persisted; check configuration access"))
      }
      if (!state.tunnel?.enabled || state.origin === undefined) yield* configureTunnel({ enabled: true })
      const result = yield* policy(true)
      if (!result.persisted) return yield* Effect.fail(new Error("Unable to persist remote control policy"))
      const companion = yield* lock.withPermits(1)(view)
      return { status: status(), tunnel: tunnelView(), companion } satisfies RemoteControl.Access
    }),
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
    policy,
    enroll,
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
export const layer = (file?: string, processID?: string, environment: Environment = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      return yield* make(
        file,
        (status) => bus.publish(RemoteControl.Changed, status).pipe(Effect.asVoid),
        undefined,
        processID,
        undefined,
        undefined,
        environment,
      )
    }),
  )
export * as RemoteService from "./remote-control"
