export * as ClaudeCodeExecutable from "./executable.js"

import fs from "node:fs"
import path from "node:path"

/**
 * Resolves the `claude` binary into a path the Claude Agent SDK can spawn
 * directly via `pathToClaudeCodeExecutable`.
 *
 * The SDK spawns the given path without a shell and without Windows
 * PATH/PATHEXT resolution, so a bare `claude` fails outright and an npm
 * `claude.cmd` shim fails with `spawn EINVAL` (Node >= 20.12). On Windows the
 * command is resolved against PATH/PATHEXT and, when the hit is an npm
 * launcher shim, followed to the real package entry (`bin/claude.exe`, or
 * `cli.js` which the SDK runs with a JavaScript runtime).
 */

const WINDOWS_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"])

const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const

export type Resolution = { readonly path: string } | { readonly error: string }

export type Filesystem = {
  readonly isFile: (filePath: string) => boolean
}

const realFilesystem: Filesystem = {
  isFile: (filePath) => {
    try {
      return fs.statSync(filePath).isFile()
    } catch {
      return false
    }
  },
}

function pathModule(platform: string) {
  return platform === "win32" ? path.win32 : path.posix
}

function pathCandidates(command: string, env: Record<string, string | undefined>, platform: string): string[] {
  const p = pathModule(platform)
  const dirs = (env.PATH ?? env.Path ?? "").split(p.delimiter).filter(Boolean)
  if (platform !== "win32") return dirs.map((dir) => p.join(dir, command))
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  const names = p.extname(command) ? [command] : [command, ...exts.map((ext) => command + ext.toLowerCase())]
  return dirs.flatMap((dir) => names.map((name) => p.join(dir, name)))
}

/** Follow a Windows npm launcher shim to the real package entry beside it. */
function followShim(shimPath: string, filesystem: Filesystem): string | undefined {
  const shimDirectory = path.win32.dirname(shimPath)
  for (const segments of NPM_PACKAGE_ENTRY_CANDIDATES) {
    const candidate = path.win32.join(shimDirectory, ...segments)
    if (filesystem.isFile(candidate)) return candidate
  }
  return undefined
}

export function resolveWith(input: {
  binaryPath?: string
  env: Record<string, string | undefined>
  platform: string
  filesystem?: Filesystem
}): Resolution {
  const filesystem = input.filesystem ?? realFilesystem
  const configured = input.binaryPath?.trim()

  if (configured && (configured.includes("/") || configured.includes("\\"))) {
    if (!filesystem.isFile(configured)) return { error: `Configured claude_code.binary_path not found: ${configured}` }
    if (input.platform === "win32" && WINDOWS_SHIM_EXTENSIONS.has(path.win32.extname(configured).toLowerCase())) {
      const target = followShim(configured, filesystem)
      if (target) return { path: target }
      return { error: `Configured claude_code.binary_path is a launcher shim the Claude Agent SDK cannot spawn: ${configured}` }
    }
    return { path: configured }
  }

  const command = configured || "claude"
  if (input.platform !== "win32") {
    for (const candidate of pathCandidates(command, input.env, input.platform)) {
      if (filesystem.isFile(candidate)) return { path: candidate }
    }
    return {
      error: "Claude Code CLI (`claude`) was not found on PATH. Install it and sign in once, or set claude_code.binary_path.",
    }
  }

  for (const candidate of pathCandidates(command, input.env, input.platform)) {
    if (!filesystem.isFile(candidate)) continue
    const extension = path.win32.extname(candidate).toLowerCase()
    if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) return { path: candidate }
    const target = followShim(candidate, filesystem)
    if (target) return { path: target }
  }
  return {
    error: "Claude Code CLI (`claude`) was not found on PATH. Install it and sign in once, or set claude_code.binary_path.",
  }
}

let cached: { key: string; result: Resolution } | undefined

/** Cached production resolution keyed on the configured binary path. */
export function resolve(binaryPath?: string): Resolution {
  const key = binaryPath ?? ""
  if (cached?.key === key) return cached.result
  const result = resolveWith({ binaryPath, env: process.env, platform: process.platform })
  cached = { key, result }
  return result
}

export function resetCache(): void {
  cached = undefined
}
