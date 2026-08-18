import { describe, expect, it } from "bun:test"
import { ClaudeCodeExecutable } from "@opencode-ai/core/plugin/redsun/claude-code/executable"
import { ClaudeCodeModels } from "@opencode-ai/core/plugin/redsun/claude-code/models"

const fs = (files: readonly string[]) => ({ isFile: (p: string) => files.includes(p) })

describe("ClaudeCodeModels", () => {
  it("exposes the CLI aliases verbatim as model ids", () => {
    expect(ClaudeCodeModels.MODELS.map((model) => String(model.id))).toEqual([
      "fable",
      "opus",
      "opus[1m]",
      "sonnet",
      "sonnet[1m]",
      "haiku",
    ])
    expect(ClaudeCodeModels.cliModel("opus[1m]")).toBe("opus[1m]")
  })

  it("names the provider the way the V1 picker did", () => {
    expect(ClaudeCodeModels.providerInfo().name).toBe("Anthropic (Claude Code)")
    expect(String(ClaudeCodeModels.PROVIDER_ID)).toBe("claude-code")
  })

  it("prices every model at zero because usage is on the subscription", () => {
    for (const model of ClaudeCodeModels.MODELS) expect(model.cost).toEqual([])
  })

  it("carries the sentinel package so real SDK resolution can never claim it", () => {
    expect(ClaudeCodeModels.SENTINEL_PACKAGE).toBe("@redsun/claude-code-delegated")
    for (const model of ClaudeCodeModels.MODELS) expect(model.package).toBe(ClaudeCodeModels.SENTINEL_PACKAGE)
  })

  it("gives the 1m variants a larger context than the 200k ones", () => {
    const byID = new Map(ClaudeCodeModels.MODELS.map((model) => [String(model.id), model]))
    expect(byID.get("sonnet")?.limit.context).toBe(200_000)
    expect(byID.get("sonnet[1m]")?.limit.context).toBe(1_000_000)
    expect(byID.get("fable")?.limit.context).toBe(1_000_000)
  })

  it("identifies delegated models", () => {
    expect(ClaudeCodeModels.isDelegated({ providerID: "claude-code" })).toBe(true)
    expect(ClaudeCodeModels.isDelegated({ providerID: "anthropic" })).toBe(false)
  })

  it("covers every sentinel-bearing model with the delegated predicate", () => {
    // The sentinel is never installed because the aisdk `language` hook answers
    // these models before package resolution, and `isDelegated` is the predicate
    // that hook and the compaction guards key on. So the set of models carrying
    // the sentinel and the set the predicate claims must be the same set.
    // (This asserts the predicate's coverage, not the hook's ordering, which
    // only a live aisdk resolution would prove.)
    const provider = ClaudeCodeModels.providerInfo()
    expect(provider.package).toBe(ClaudeCodeModels.SENTINEL_PACKAGE)
    for (const model of ClaudeCodeModels.MODELS) {
      expect(model.package).toBe(ClaudeCodeModels.SENTINEL_PACKAGE)
      expect(ClaudeCodeModels.isDelegated(model)).toBe(true)
    }
  })

  it("stays visible without a connection", () => {
    // catalog.ts hides an `auto` provider that has an integration with no
    // connections, and auth.ts registers one. Autodetection is the contract:
    // the plugin only registers anything once the binary resolves.
    expect(ClaudeCodeModels.providerInfo().activation).toBe("enabled")
  })
})

describe("ClaudeCodeExecutable", () => {
  it("finds claude on a posix PATH", () => {
    expect(
      ClaudeCodeExecutable.resolveWith({
        env: { PATH: "/usr/local/bin:/usr/bin" },
        platform: "linux",
        filesystem: fs(["/usr/bin/claude"]),
      }),
    ).toEqual({ path: "/usr/bin/claude" })
  })

  it("follows a windows npm shim to the real package entry", () => {
    const shimDir = "C:\\npm"
    const entry = shimDir + "\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"
    expect(
      ClaudeCodeExecutable.resolveWith({
        env: { PATH: shimDir, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
        filesystem: fs([shimDir + "\\claude.cmd", entry]),
      }),
    ).toEqual({ path: entry })
  })

  it("follows a .bat shim as well as a .cmd one", () => {
    const shimDir = "C:\\npm"
    const entry = shimDir + "\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"
    expect(
      ClaudeCodeExecutable.resolveWith({
        env: { PATH: shimDir, PATHEXT: ".EXE;.BAT" },
        platform: "win32",
        filesystem: fs([shimDir + "\\claude.bat", entry]),
      }),
    ).toEqual({ path: entry })
  })

  it("falls back to cli.js when the shim has no packaged exe", () => {
    const shimDir = "C:\\npm"
    const entry = shimDir + "\\node_modules\\@anthropic-ai\\claude-code\\cli.js"
    expect(
      ClaudeCodeExecutable.resolveWith({
        env: { PATH: shimDir, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
        filesystem: fs([shimDir + "\\claude.cmd", entry]),
      }),
    ).toEqual({ path: entry })
  })

  it("follows a configured path that is itself a shim", () => {
    const shimDir = "C:\\npm"
    const shim = shimDir + "\\claude.ps1"
    const entry = shimDir + "\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"
    expect(
      ClaudeCodeExecutable.resolveWith({
        binaryPath: shim,
        env: {},
        platform: "win32",
        filesystem: fs([shim, entry]),
      }),
    ).toEqual({ path: entry })
  })

  it("rejects a configured shim with nothing behind it", () => {
    // The SDK spawns without a shell, so handing it a launcher shim fails with
    // `spawn EINVAL` at the first turn instead of here.
    const shim = "C:\\npm\\claude.ps1"
    const result = ClaudeCodeExecutable.resolveWith({
      binaryPath: shim,
      env: {},
      platform: "win32",
      filesystem: fs([shim]),
    })
    expect("error" in result && result.error).toContain("launcher shim")
  })

  it("reports an actionable error when the CLI is absent", () => {
    const result = ClaudeCodeExecutable.resolveWith({ env: { PATH: "/usr/bin" }, platform: "linux", filesystem: fs([]) })
    expect(result).toHaveProperty("error")
    expect("error" in result && result.error).toContain("not found on PATH")
  })

  it("rejects a configured path that does not exist", () => {
    const result = ClaudeCodeExecutable.resolveWith({
      binaryPath: "/opt/claude",
      env: {},
      platform: "linux",
      filesystem: fs([]),
    })
    expect("error" in result && result.error).toContain("binary_path not found")
  })
})
