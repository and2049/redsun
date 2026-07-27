import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import os from "node:os"
import fs from "node:fs"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"

export type Method = "curl" | "powershell" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `redsun/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (method === "choco") return "not running from an elevated command shell"
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        const response = yield* httpOk.execute(
          HttpClientRequest.get("https://github.com/and2049/redsun/releases/latest/download/install"),
        )
        const body = yield* response.text
        const bodyBytes = new TextEncoder().encode(body)
        const shell = yield* upgradeScriptShell()
        const result = yield* appProcess.run(
          ChildProcess.make(shell, [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("curl") })),
    )

    const upgradeScriptShellWindows = Effect.fnUntraced(function* () {
      const pwshVersion = yield* text(["pwsh", "--version"])
      if (pwshVersion) return "pwsh"
      return "powershell"
    })

    const upgradePowerShell = Effect.fnUntraced(
      function* (target: string) {
        const response = yield* httpOk.execute(
          HttpClientRequest.get("https://github.com/and2049/redsun/releases/latest/download/install.ps1"),
        )
        const body = yield* response.text
        const shell = yield* upgradeScriptShellWindows()
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "redsun-upgrade-"))
        const scriptPath = path.join(tmpDir, "install.ps1")
        fs.writeFileSync(scriptPath, body, { encoding: "utf8" })
        const result = yield* appProcess.run(
          ChildProcess.make(shell, [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            "-Version",
            target,
            "-NoModifyPath",
          ], {
            extendEnv: true,
          }),
        )
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true })
        } catch {}
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("powershell") })),
    )

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        const binFromRelease =
          process.execPath.includes(path.join(".redsun", "bin")) ||
          process.execPath.includes(path.join(".local", "bin"))
        if (binFromRelease) {
          if (process.platform === "win32") return "powershell" as Method
          return "curl" as Method
        }
        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* () {
        const response = yield* httpOk.execute(
          HttpClientRequest.get("https://api.github.com/repos/and2049/redsun/releases/latest").pipe(
            HttpClientRequest.acceptJson,
          ),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        return data.tag_name.replace(/^v/, "")
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        if (m === "curl" || m === "unknown") {
          if (process.platform === "win32") {
            const psResult = yield* upgradePowerShell(target)
            if (!psResult || psResult.code !== 0) {
              return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, psResult) })
            }
            yield* Effect.logInfo("upgraded", {
              method: "powershell",
              target,
              stdout: psResult.stdout,
              stderr: psResult.stderr,
            })
            yield* text([process.execPath, "--version"])
            return
          }
          const curlResult = yield* upgradeCurl(target)
          if (!curlResult || curlResult.code !== 0) {
            return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, curlResult) })
          }
          yield* Effect.logInfo("upgraded", {
            method: "curl",
            target,
            stdout: curlResult.stdout,
            stderr: curlResult.stderr,
          })
          yield* text([process.execPath, "--version"])
          return
        }
        if (m === "powershell") {
          const psResult = yield* upgradePowerShell(target)
          if (!psResult || psResult.code !== 0) {
            return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, psResult) })
          }
          yield* Effect.logInfo("upgraded", {
            method: "powershell",
            target,
            stdout: psResult.stdout,
            stderr: psResult.stderr,
          })
          yield* text([process.execPath, "--version"])
          return
        }
        return yield* new UpgradeFailedError({ stderr: `Unsupported redsun installation method: ${m}` })
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
