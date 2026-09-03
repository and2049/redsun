import { Global } from "@opencode-ai/util/global"
import { AppProcess } from "@opencode-ai/util/process"
import { OpenCode } from "@opencode-ai/client"
import { PersistentPty } from "@opencode-ai/schema/persistent-pty"
import { OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { Context, Duration, Effect, FileSystem, Layer, Ref, Schedule, Semaphore, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import { action, parseReleaseVersion, type Action, type Policy } from "./updater-action"

export const methods = ["curl", "powershell"] as const
export type Method = (typeof methods)[number]

export const REPOSITORY = "and2049/redsun"
export const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
export const INSTALLER = `https://github.com/${REPOSITORY}/releases/latest/download/install`
export const INSTALLER_WINDOWS = `https://github.com/${REPOSITORY}/releases/latest/download/install.ps1`

export function versionFromRelease(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("tag_name" in data)) return undefined
  const tag = data.tag_name
  if (typeof tag !== "string" || !tag) return undefined
  return tag.replace(/^v/, "")
}

export interface Interface {
  readonly check: () => Effect.Effect<void>
  readonly monitor: (input: {
    readonly url: string
    readonly password: string
    readonly managed: boolean
    readonly notify: (version: string) => Effect.Effect<void>
    readonly restart: (handoff: PersistentPty.Handoff | null) => Effect.Effect<void>
  }) => Effect.Effect<void>
  readonly apply: (version: string) => Effect.Effect<void, Error>
  readonly method: () => Effect.Effect<Method | undefined>
  readonly latest: () => Effect.Effect<string, Error>
  readonly upgrade: (method: Method, version: string) => Effect.Effect<void, Error>
}

export type Inspection =
  | { readonly action: "none" }
  | { readonly action: Exclude<Action, "none">; readonly version: string }

type State =
  | { readonly type: "current" }
  | { readonly type: "available"; readonly version: string; readonly availableSince: number }
  | { readonly type: "ready-to-restart"; readonly version: string }

export interface MonitorInput {
  readonly url: string
  readonly password: string
  readonly managed: boolean
  readonly inspect: () => Effect.Effect<Inspection, Error>
  readonly install: (version: string) => Effect.Effect<boolean, Error>
  readonly restart: (handoff: PersistentPty.Handoff | null) => Effect.Effect<void>
  readonly interval?: Duration.Input
  readonly notificationThreshold?: Duration.Input
  readonly notify: (version: string) => Effect.Effect<void>
}

export const monitorServer = Effect.fnUntraced(function* (input: MonitorInput) {
  const state = yield* Ref.make<State>({ type: "current" })
  const applyLock = yield* Semaphore.make(1)
  const client = OpenCode.make({
    baseUrl: input.url,
    headers: { authorization: `Basic ${btoa(`redsun:${input.password}`)}` },
  })

  const applyIfIdle = () =>
    applyLock.withPermit(
      Effect.gen(function* () {
        const pending = yield* Ref.get(state)
        if (pending.type !== "available") return
        const active = yield* Effect.tryPromise({
          try: () => client.session.active(),
          catch: (cause) => new Error("Failed to read active sessions", { cause }),
        })
        if (Object.keys(active).length > 0) return
        const latest = yield* input.inspect()
        if (latest.action !== "upgrade") {
          yield* Ref.set(state, { type: "current" })
          return
        }
        const installed = yield* input
          .install(latest.version)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("automatic update failed", { cause: error }).pipe(Effect.as(false)),
            ),
          )
        if (!installed) return
        const handoff = input.managed
          ? yield* Effect.tryPromise({
              try: () => client.experimental.persistentPty.handoff(),
              catch: (cause) => new Error("Failed to prepare persistent terminals for restart", { cause }),
            })
          : undefined
        yield* Ref.set(state, { type: "ready-to-restart", version: latest.version })
        if (handoff) yield* input.restart(handoff.handoff)
      }),
    )

  const checkServer = Effect.gen(function* () {
    const result = yield* input.inspect()
    if (result.action === "notify") {
      yield* input.notify(result.version)
      return
    }
    if (result.action !== "upgrade") {
      yield* Ref.update(
        state,
        (current): State => (current.type === "ready-to-restart" ? current : { type: "current" }),
      )
      return
    }
    yield* Ref.update(state, (current): State => {
      if (current.type === "ready-to-restart" && current.version === result.version) return current
      return {
        type: "available",
        version: result.version,
        availableSince: current.type === "available" ? current.availableSince : Date.now(),
      }
    })
    yield* applyIfIdle()
    const pending = yield* Ref.get(state)
    if (
      pending.type === "available" &&
      Date.now() - pending.availableSince >= Duration.toMillis(input.notificationThreshold ?? "3 days")
    )
      yield* input.notify(pending.version)
  }).pipe(Effect.catch((cause) => Effect.logWarning("automatic update check failed", { cause })))

  const subscribe = Effect.suspend(() =>
    Stream.fromAsyncIterable(
      client.event.subscribe(),
      (cause) => new Error("Update event stream failed", { cause }),
    ).pipe(
      Stream.runForEach((event) => {
        if (event.type === "server.connected") return applyIfIdle()
        if (
          event.type !== "session.execution.succeeded" &&
          event.type !== "session.execution.failed" &&
          event.type !== "session.execution.interrupted"
        )
          return Effect.void
        return Effect.tryPromise({
          try: () => client.session.wait({ sessionID: event.data.sessionID }),
          catch: (cause) => new Error(`Failed to wait for Session ${event.data.sessionID}`, { cause }),
        }).pipe(Effect.andThen(applyIfIdle()))
      }),
      Effect.catch((cause) => Effect.logWarning("update event stream disconnected", { cause })),
    ),
  ).pipe(Effect.repeat(Schedule.spaced("1 second")))

  return yield* Effect.all(
    [checkServer.pipe(Effect.repeat(Schedule.spaced(input.interval ?? "10 minutes"))), subscribe],
    {
      concurrency: "unbounded",
      discard: true,
    },
  )
})

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

export function decodePolicy(text: string): Policy | undefined {
  // The CLI only projects this host-level preference instead of initializing
  // the location-scoped server configuration graph.
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null) return
  if ("update" in input) {
    const value = input.update
    if (value === "disable" || value === "notify" || value === "auto") return value
    return
  }
  if (!("autoupdate" in input)) return
  if (input.autoupdate === false) return "disable"
  if (input.autoupdate === "notify") return "notify"
  if (input.autoupdate === true) return "auto"
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service

  const readPolicy = Effect.fnUntraced(function* () {
    const values = yield* Effect.forEach(["config.json", "redsun.json", "redsun.jsonc"], (name) =>
      fs.readFileString(path.join(global.config, name)).pipe(
        Effect.map(decodePolicy),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return values.findLast((value) => value !== undefined) ?? "auto"
  })

  const run = Effect.fnUntraced(function* (command: string[], timeout: Duration.Input = "10 seconds") {
    return yield* appProcess
      .run(ChildProcess.make(command[0], command.slice(1)), {
        timeout,
        maxOutputBytes: 100_000,
        maxErrorBytes: 100_000,
      })
      .pipe(
        Effect.map((result) => ({
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        })),
        Effect.orElseSucceed(() => ({ code: 1, stdout: "", stderr: "" })),
      )
  })

  const method = Effect.fnUntraced(function* () {
    return process.platform === "win32" ? ("powershell" as const) : ("curl" as const)
  })

  const latest = Effect.fnUntraced(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(RELEASE_API, {
          headers: { "User-Agent": `redsun/${OPENCODE_VERSION}` },
          signal: AbortSignal.timeout(10_000),
        }),
      catch: (cause) => new Error("Failed to check for updates", { cause }),
    })
    if (!response.ok) return yield* Effect.fail(new Error(`Update check failed with status ${response.status}`))
    const data = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new Error("Failed to read update information", { cause }),
    })
    const version = versionFromRelease(data)
    if (!version) return yield* Effect.fail(new Error("Update information did not include a version"))
    return version
  })

  const upgrade = Effect.fnUntraced(function* (method: Method, input: string) {
    if (!parseReleaseVersion(input)) return yield* Effect.fail(new Error(`Invalid version: ${input}`))
    const version = input.trim().replace(/^v/, "")
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(global.cache, { recursive: true })
        const directory = yield* fs.makeTempDirectoryScoped({ directory: global.cache, prefix: "update-" })
        if (method === "powershell") {
          const installer = path.join(directory, "install.ps1")
          const download = yield* run(["curl", "-fsSL", "-o", installer, INSTALLER_WINDOWS], "5 minutes")
          if (download.code !== 0) return download
          return yield* run(
            [
              "powershell",
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              installer,
              "-Version",
              version,
              "-NoModifyPath",
            ],
            "5 minutes",
          )
        }
        const installer = path.join(directory, "install")
        const download = yield* run(["curl", "-fsSL", "-o", installer, INSTALLER], "5 minutes")
        if (download.code !== 0) return download
        return yield* run(["bash", installer, "--version", version, "--no-modify-path"], "5 minutes")
      }),
    ).pipe(Effect.mapError((cause) => new Error(`Failed to update with ${method}`, { cause })))
    if (result.code === 0) return
    // install.ps1 prints its failure reasons to stdout (Write-Host), so fall
    // back to stdout before the generic message.
    const detail = result.stderr.trim() || result.stdout.trim()
    return yield* Effect.fail(new Error(detail || `Failed to update with ${method}`))
  })

  const inspect = Effect.fnUntraced(function* (): Effect.fn.Return<Inspection, Error> {
    if (OPENCODE_LOCAL || ["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? "")) {
      yield* Effect.logInfo("update check skipped", {
        reason: OPENCODE_LOCAL ? "local-install" : "disabled",
        version: OPENCODE_VERSION,
        channel: OPENCODE_CHANNEL,
      })
      return { action: "none" }
    }
    const policy = yield* readPolicy()
    if (policy === "disable") {
      yield* Effect.logInfo("update check skipped", { reason: "policy-disabled" })
      return { action: "none" }
    }

    const version = yield* latest()
    yield* Effect.logInfo("update check", {
      current: OPENCODE_VERSION,
      latest: version,
    })
    const next = action(OPENCODE_VERSION, version, policy)
    if (next === "none") {
      yield* Effect.logInfo("update check done", { action: "up-to-date" })
      return { action: "none" }
    }
    if (next === "notify") {
      yield* Effect.logInfo("redsun update available", { current: OPENCODE_VERSION, latest: version })
      return { action: next, version }
    }
    return { action: next, version }
  })

  const install = Effect.fnUntraced(function* (version: string) {
    const detected = yield* method()
    yield* upgrade(detected, version)
    yield* Effect.logInfo("updated redsun", { from: OPENCODE_VERSION, to: version, method: detected })
    return true
  })

  const apply = Effect.fn("cli.updater.apply")(function* (version: string) {
    yield* install(version)
  })

  const check = Effect.fn("cli.updater.check")(
    function* () {
      const result = yield* inspect()
      if (result.action !== "upgrade") return
      yield* install(result.version)
    },
    Effect.catchCause((cause) => Effect.logWarning("automatic update failed", { cause })),
  )

  const monitor = Effect.fn("cli.updater.monitor")(function* (input: {
    readonly url: string
    readonly password: string
    readonly managed: boolean
    readonly notify: (version: string) => Effect.Effect<void>
    readonly restart: (handoff: PersistentPty.Handoff | null) => Effect.Effect<void>
  }) {
    return yield* monitorServer({ ...input, inspect, install })
  })

  return Service.of({ check, monitor, apply, method, latest, upgrade })
})

export const layer = Layer.effect(Service, make)

export * as Updater from "./updater"
export { action, type Action, type Policy } from "./updater-action"
