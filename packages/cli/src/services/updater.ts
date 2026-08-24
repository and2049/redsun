import { Global } from "@opencode-ai/util/global"
import { AppProcess } from "@opencode-ai/util/process"
import { OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { Context, Duration, Effect, FileSystem, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { parse, type ParseError } from "jsonc-parser"
import path from "node:path"
import { action, type Policy } from "./updater-action"

export type Method = "curl" | "powershell"

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

export type UpgradeResult = {
  readonly status: "current" | "upgraded"
  readonly from: string
  readonly to: string
  readonly method: Method
}

export interface Interface {
  readonly check: () => Effect.Effect<void>
  readonly upgrade: (input?: {
    readonly target?: string
    readonly method?: Method
  }) => Effect.Effect<UpgradeResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/Updater") {}

export function decodePolicy(text: string): Policy | undefined {
  // The CLI only projects this host-level preference instead of initializing
  // the location-scoped server configuration graph.
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null || !("autoupdate" in input)) return
  const value = input.autoupdate
  if (typeof value === "boolean" || value === "notify") return value
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
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
      return values.findLast((value) => value !== undefined) ?? true
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

    const upgrade = Effect.fnUntraced(function* (method: Method, version: string) {
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
      )
      if (result.code === 0) return
      // install.ps1 prints its failure reasons to stdout (Write-Host), so fall
      // back to stdout before the generic message.
      const detail = result.stderr.trim() || result.stdout.trim()
      return yield* Effect.fail(new Error(detail || `Failed to update with ${method}`))
    })

    const check = Effect.fn("cli.updater.check")(
      function* () {
        if (OPENCODE_LOCAL || ["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? ""))
          return yield* Effect.logInfo("update check skipped", {
            reason: OPENCODE_LOCAL ? "local-install" : "disabled",
            version: OPENCODE_VERSION,
            channel: OPENCODE_CHANNEL,
          })
        const policy = yield* readPolicy()
        if (policy === false) return yield* Effect.logInfo("update check skipped", { reason: "policy-disabled" })

        return yield* Effect.gen(function* () {
          const version = yield* latest()
          yield* Effect.logInfo("update check", {
            current: OPENCODE_VERSION,
            latest: version,
          })
          const next = action(OPENCODE_VERSION, version, policy)
          if (next === "none") return yield* Effect.logInfo("update check done", { action: "up-to-date" })
          const detected = yield* method()
          yield* upgrade(detected, version)
          yield* Effect.logInfo("updated redsun", { from: OPENCODE_VERSION, to: version, method: detected })
        })
      },
      Effect.catchCause((cause) => Effect.logWarning("automatic update failed", { cause })),
    )

    const request = Effect.fnUntraced(function* (input: { target?: string; method?: Method } = {}) {
      const to = input.target ? input.target.replace(/^v/, "") : yield* latest()
      const detected = input.method ?? (yield* method())
      if (to === OPENCODE_VERSION) return { status: "current" as const, from: OPENCODE_VERSION, to, method: detected }
      yield* upgrade(detected, to)
      return { status: "upgraded" as const, from: OPENCODE_VERSION, to, method: detected }
    })

    return Service.of({ check, upgrade: request })
  }),
)

export * as Updater from "./updater"
export { action, type Action, type Policy } from "./updater-action"
