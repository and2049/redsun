import { Global } from "@opencode-ai/util/global"
import { AppProcess } from "@opencode-ai/util/process"
import { OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { Context, Duration, Effect, FileSystem, Layer, Ref, Schedule } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import { action, parseReleaseVersion, type Policy } from "./updater-action"

export const methods = ["curl", "powershell"] as const
export type Method = (typeof methods)[number]
export type RunResult = { readonly type: "available" | "installed"; readonly version: string }
export type CheckResult = RunResult | { readonly type: "unavailable"; readonly message: string }

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
  readonly run: () => Effect.Effect<RunResult | undefined>
  readonly check: () => Effect.Effect<CheckResult | undefined, Error>
  readonly apply: (version: string) => Effect.Effect<void, Error>
  readonly method: () => Effect.Effect<Method | undefined>
  readonly latest: () => Effect.Effect<string, Error>
  readonly upgrade: (method: Method, version: string) => Effect.Effect<void, Error>
}

export const pollUpdates = Effect.fnUntraced(function* (input: {
  readonly check: Effect.Effect<unknown>
  readonly initialDelay?: Duration.Input
  readonly interval?: Duration.Input
}) {
  const interval = input.interval ?? "10 minutes"
  return yield* input.check.pipe(
    Effect.repeat(Schedule.spaced(interval)),
    Effect.delay(input.initialDelay ?? "1 minute"),
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
  const installedVersion = yield* Ref.make(OPENCODE_VERSION)

  const readPolicy = Effect.fnUntraced(function* () {
    const values = yield* Effect.forEach(["config.json", "redsun.json", "redsun.jsonc"], (name) =>
      fs.readFileString(path.join(global.config, name)).pipe(
        Effect.map(decodePolicy),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return values.findLast((value) => value !== undefined) ?? "notify"
  })

  const exec = Effect.fnUntraced(function* (command: string[], timeout: Duration.Input = "10 seconds") {
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
      try: (signal) =>
        fetch(RELEASE_API, {
          headers: { "User-Agent": `redsun/${OPENCODE_VERSION}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
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
          const download = yield* exec(["curl", "-fsSL", "-o", installer, INSTALLER_WINDOWS], "5 minutes")
          if (download.code !== 0) return download
          return yield* exec(
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
        const download = yield* exec(["curl", "-fsSL", "-o", installer, INSTALLER], "5 minutes")
        if (download.code !== 0) return download
        return yield* exec(["bash", installer, "--version", version, "--no-modify-path"], "5 minutes")
      }),
    ).pipe(Effect.mapError((cause) => new Error(`Failed to update with ${method}`, { cause })))
    if (result.code === 0) return
    // install.ps1 prints its failure reasons to stdout (Write-Host), so fall
    // back to stdout before the generic message.
    const detail = result.stderr.trim() || result.stdout.trim()
    return yield* Effect.fail(new Error(detail || `Failed to update with ${method}`))
  })

  const inspect = Effect.fnUntraced(function* () {
    if (OPENCODE_LOCAL || ["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? "")) {
      yield* Effect.logInfo("update check skipped", {
        reason: OPENCODE_LOCAL ? "local-install" : "disabled",
        version: OPENCODE_VERSION,
        channel: OPENCODE_CHANNEL,
      })
      return undefined
    }
    const policy = yield* readPolicy()
    if (policy === "disable") {
      yield* Effect.logInfo("update check skipped", { reason: "policy-disabled" })
      return undefined
    }

    const current = yield* Ref.get(installedVersion)
    const version = yield* latest()
    yield* Effect.logInfo("update check", {
      current,
      latest: version,
    })
    const next = action(current, version, policy)
    if (next === "none") {
      yield* Effect.logInfo("update check done", { action: "up-to-date" })
      return undefined
    }
    yield* Effect.logInfo("redsun update available", { current, latest: version, action: next })
    return { policy, version }
  })

  const install = Effect.fnUntraced(function* (version: string) {
    const detected = yield* method()
    if (!detected) {
      yield* Effect.logWarning("update skipped: installation method not found")
      return false
    }
    const current = yield* Ref.get(installedVersion)
    yield* upgrade(detected, version)
    yield* Ref.set(installedVersion, version)
    yield* Effect.logInfo("updated redsun", { from: current, to: version, method: detected })
    return true
  })

  const apply = Effect.fn("cli.updater.apply")(function* (version: string) {
    yield* install(version)
  })

  const check = Effect.fn("cli.updater.check")(function* () {
    if (OPENCODE_LOCAL)
      return {
        type: "unavailable" as const,
        message: "This build runs from a source checkout. Use an installed redsun release to check for updates.",
      }
    const version = yield* latest()
    if (!parseReleaseVersion(version)) return yield* Effect.fail(new Error(`Invalid version: ${version}`))
    const current = yield* Ref.get(installedVersion)
    if (action(current, version, "auto") === "none") {
      // An earlier check may have installed the update while this client is still running.
      return action(OPENCODE_VERSION, current, "auto") === "none"
        ? undefined
        : { type: "installed" as const, version: current }
    }
    return { type: "available" as const, version }
  })

  const run = Effect.fn("cli.updater.run")(
    function* () {
      const result = yield* inspect()
      if (!result) return undefined
      if (result.policy === "notify") return { type: "available" as const, version: result.version }
      if (!(yield* install(result.version))) return yield* Effect.fail(new Error("Installation method not found"))
      return { type: "installed" as const, version: result.version }
    },
    Effect.catch((error) => Effect.logWarning("update check failed", { error }).pipe(Effect.as(undefined))),
  )

  return Service.of({ run, check, apply, method, latest, upgrade })
})

export const layer = Layer.effect(Service, make)

export * as Updater from "./updater"
export { action, type Action, type Policy } from "./updater-action"
