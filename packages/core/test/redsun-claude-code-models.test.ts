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
