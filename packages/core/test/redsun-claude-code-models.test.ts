import { describe, expect, it } from "bun:test"
import { ClaudeCodeExecutable } from "@redsun/runtime-claude-code/executable"
import { ClaudeCodeModels } from "@redsun/runtime-claude-code/models"
import { Provider } from "@opencode/core/provider"

const fs = (files: readonly string[]) => ({ isFile: (p: string) => files.includes(p) })

describe("ClaudeCodeModels", () => {
  it("exposes the CLI aliases and pinned ids verbatim as model ids", () => {
    expect(ClaudeCodeModels.MODELS.map((model) => String(model.id))).toEqual([
      "fable",
      "opus",
      "opus[1m]",
      "sonnet",
      "sonnet[1m]",
      "haiku",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5-5",
      "claude-opus-4-8",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ])
    expect(ClaudeCodeModels.cliModel("opus[1m]")).toBe("opus[1m]")
    expect(ClaudeCodeModels.cliModel("claude-opus-4-8")).toBe("claude-opus-4-8")
  })

  it("names the provider the way the V1 picker did", () => {
    expect(ClaudeCodeModels.providerInfo().name).toBe("Anthropic (Claude Code)")
    expect(String(ClaudeCodeModels.PROVIDER_ID)).toBe("claude-code")
  })

  it("prices every model at zero because usage is on the subscription", () => {
    for (const model of ClaudeCodeModels.MODELS) expect(model.cost).toEqual([])
  })

  it("carries the sentinel package so real SDK resolution can never claim it", () => {
    expect(ClaudeCodeModels.SENTINEL_NAME).toBe("@redsun/claude-code-delegated")
    for (const model of ClaudeCodeModels.MODELS) expect(model.package).toBe(ClaudeCodeModels.SENTINEL_PACKAGE)
  })

  it("routes the sentinel to the aisdk hooks rather than to npm", () => {
    // The prefix is the whole mechanism. `model-resolver.ts` hands an
    // `aisdk:`-prefixed package to `AISDK.model`, which fires the `sdk` and
    // `language` hooks the provider answers; anything else goes to
    // `Provider.loadPackage`, which tried to import this name from npm and
    // failed with "Unsupported package for claude-code/sonnet" -- so no
    // delegated turn could run at all.
    expect(Provider.isAISDK(ClaudeCodeModels.SENTINEL_PACKAGE)).toBe(true)
    expect(Provider.packageName(ClaudeCodeModels.SENTINEL_PACKAGE)).toBe(ClaudeCodeModels.SENTINEL_NAME)
    // Still not a real package name: nothing resolvable may be reachable here.
    expect(ClaudeCodeModels.SENTINEL_NAME.startsWith("@ai-sdk/")).toBe(false)
  })

  it("gives the 1m variants a larger context than the 200k ones", () => {
    const byID = new Map(ClaudeCodeModels.MODELS.map((model) => [String(model.id), model]))
    expect(byID.get("sonnet")?.limit.context).toBe(200_000)
    expect(byID.get("sonnet[1m]")?.limit.context).toBe(1_000_000)
    expect(byID.get("fable")?.limit.context).toBe(1_000_000)
    expect(byID.get("claude-opus-4-8")?.limit.context).toBe(1_000_000)
    expect(byID.get("claude-sonnet-4-5")?.limit.context).toBe(200_000)
    expect(byID.get("claude-haiku-4-5")?.limit.context).toBe(200_000)
  })

  it("flags a silent CLI substitution only for pinned ids", () => {
    // Aliases resolve to a concrete model by design; a pinned id must be
    // served verbatim or as a dated snapshot of itself.
    expect(ClaudeCodeModels.isSubstituted("opus", "claude-opus-5")).toBe(false)
    expect(ClaudeCodeModels.isSubstituted("sonnet[1m]", "claude-sonnet-5")).toBe(false)
    expect(ClaudeCodeModels.isSubstituted("claude-opus-4-8", "claude-opus-4-8")).toBe(false)
    expect(ClaudeCodeModels.isSubstituted("claude-opus-4-8", "claude-opus-4-8-20260101")).toBe(false)
    expect(ClaudeCodeModels.isSubstituted("claude-sonnet-4-5[1m]", "claude-sonnet-4-5-20250929")).toBe(false)
    expect(ClaudeCodeModels.isSubstituted("claude-opus-4-1", "claude-opus-5")).toBe(true)
    expect(ClaudeCodeModels.isSubstituted("claude-opus-4-8", "claude-opus-5")).toBe(true)
    expect(ClaudeCodeModels.isSubstituted("claude-opus-4-8", "")).toBe(false)
  })

  it("flags an alias substitution once the CLI has said what the alias resolves to", () => {
    // supportedModels() supplies `resolvedModel` per picker row; with it a
    // quota fallback (opus turn answered by sonnet) becomes checkable too.
    expect(ClaudeCodeModels.isSubstituted("sonnet", "claude-sonnet-5", "claude-sonnet-5")).toBe(false)
    expect(ClaudeCodeModels.isSubstituted("opus[1m]", "claude-opus-5", "claude-opus-5[1m]")).toBe(false)
    expect(ClaudeCodeModels.isSubstituted("haiku", "claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(false)
    expect(ClaudeCodeModels.isSubstituted("opus[1m]", "claude-sonnet-5", "claude-opus-5[1m]")).toBe(true)
    // An unparseable or absent resolution keeps aliases exempt.
    expect(ClaudeCodeModels.isSubstituted("sonnet", "claude-opus-5")).toBe(false)
    expect(ClaudeCodeModels.isSubstituted("sonnet", "claude-opus-5", "something-else")).toBe(false)
  })

  it("retires only curated pinned ids", () => {
    expect(ClaudeCodeModels.isRetirable("claude-opus-4-8")).toBe(true)
    expect(ClaudeCodeModels.isRetirable("claude-fable-5")).toBe(true)
    expect(ClaudeCodeModels.isRetirable("claude-fable-5-1")).toBe(true)
    expect(ClaudeCodeModels.isRetirable("claude-sonnet-4-5")).toBe(true)
    expect(ClaudeCodeModels.isRetirable("opus")).toBe(false)
    expect(ClaudeCodeModels.isRetirable("opus[1m]")).toBe(false)
    // Config-added ids are the user's escape hatch and stay untouched.
    expect(ClaudeCodeModels.isRetirable("claude-opus-4-1")).toBe(false)
  })

  it("derives generation-accurate names from the CLI's resolved wire ids", () => {
    expect(ClaudeCodeModels.discoveredName({ value: "sonnet", resolvedModel: "claude-sonnet-5" })).toBe(
      "Claude Sonnet 5 (latest)",
    )
    expect(ClaudeCodeModels.discoveredName({ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" })).toBe(
      "Claude Haiku 4.5 (latest)",
    )
    expect(ClaudeCodeModels.discoveredName({ value: "opus[1m]", resolvedModel: "claude-opus-5[1m]" })).toBe(
      "Claude Opus 5 1M (latest)",
    )
    // A dated snapshot of a single-digit generation must not read the date as
    // a minor version.
    expect(ClaudeCodeModels.discoveredName({ value: "x", resolvedModel: "claude-sonnet-4-20250514" })).toBe(
      "Claude Sonnet 4",
    )
    expect(ClaudeCodeModels.discoveredName({ value: "x", displayName: "Fancy" })).toBe("Claude Fancy")
    expect(ClaudeCodeModels.discoveredName({ value: "claude-fable-5-1", displayName: "Fable 5.1 (latest)" })).toBe(
      "Claude Fable 5.1 (latest)",
    )
    expect(ClaudeCodeModels.discoveredName({ value: "claude-fable-5", displayName: "Claude Fable 5" })).toBe(
      "Claude Fable 5",
    )
    expect(ClaudeCodeModels.discoveredName({ value: "opus[1m]", displayName: "Claude Opus 5 1M" })).toBe(
      "Claude Opus 5 1M",
    )
    expect(ClaudeCodeModels.discoveredName({ value: "claude-opus-5", displayName: "Opus 5" })).toBe("Claude Opus 5")
    expect(
      ClaudeCodeModels.discoveredName({
        value: "opus[1m]",
        resolvedModel: "claude-opus-5-5[1m]",
        displayName: "Opus (1M context)",
      }),
    ).toBe("Claude Opus 5.5 1M (latest)")
    expect(
      ClaudeCodeModels.discoveredName({ value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" }),
    ).toBe("Claude Sonnet 5 (latest)")
    expect(ClaudeCodeModels.discoveredName({ value: "x" })).toBeUndefined()
  })

  it("probes only CLI initialization metadata, closes the idle query, and times out safely", async () => {
    let closed = 0
    let requested = 0
    let prompt: unknown
    const create = ((input: { prompt: unknown; options: { abortController: AbortController } }) => {
      prompt = input.prompt
      expect(input.options.abortController).toBeInstanceOf(AbortController)
      return {
        supportedModels: async () => {
          requested++
          return [
            { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1 (latest)" },
            { value: "claude-fable-5", displayName: "Fable 5" },
          ]
        },
        close: () => closed++,
      }
    }) as never
    const result = await ClaudeCodeModels.probe(create, { cwd: "/tmp", pathToClaudeCodeExecutable: "/bin/claude" })
    expect(result.map(ClaudeCodeModels.discoveredName)).toEqual(["Claude Fable 5.1 (latest)", "Claude Fable 5"])
    expect(requested).toBe(1)
    expect(closed).toBe(1)
    expect(typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function")

    const stalled = (() => ({ supportedModels: () => new Promise(() => {}), close: () => closed++ })) as never
    await expect(ClaudeCodeModels.probe(stalled, {}, 1)).rejects.toThrow("timed out")
    expect(closed).toBe(2)
    const cancelled = new AbortController()
    const pending = ClaudeCodeModels.probe(stalled, {}, 5_000, cancelled.signal)
    cancelled.abort()
    await expect(pending).rejects.toThrow("cancelled")
    expect(closed).toBe(3)
  })

  it("retains location and model settings while isolating the startup metadata probe", () => {
    const options = ClaudeCodeModels.metadataOptions({
      cwd: "/worktree",
      pathToClaudeCodeExecutable: "/custom/claude",
      env: { CLAUDE_CONFIG_DIR: "/custom/config" },
      extraArgs: { "--verbose": null },
    })
    expect(options).toMatchObject({
      cwd: "/worktree",
      pathToClaudeCodeExecutable: "/custom/claude",
      env: { CLAUDE_CONFIG_DIR: "/custom/config" },
      extraArgs: { "--verbose": null },
      settingSources: ["user", "project", "local"],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      persistSession: false,
    })
    const query = ((input: { options: unknown }) => {
      expect(input.options).toMatchObject(options)
      return { supportedModels: async () => [], close: () => {} }
    }) as never
    return ClaudeCodeModels.probe(query, options)
  })

  it("parses KV-cached picker rows and retirements defensively", () => {
    expect(
      ClaudeCodeModels.parseDiscovered([
        { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", extra: 1 },
        { value: "" },
        { resolvedModel: "claude-opus-5" },
        "junk",
        null,
      ]),
    ).toEqual([{ value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" }])
    expect(ClaudeCodeModels.parseDiscovered("junk")).toEqual([])

    const retired = ClaudeCodeModels.parseRetired({
      "claude-opus-4-8": { served: "claude-opus-5", at: "2026-08-24" },
      broken: { served: 42 },
      junk: "junk",
    })
    expect([...retired.entries()]).toEqual([["claude-opus-4-8", { served: "claude-opus-5", at: "2026-08-24" }]])
    expect(ClaudeCodeModels.parseRetired(["not", "a", "record"]).size).toBe(0)
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

  it("applies retirements and discovered picker rows through the catalog transform", () => {
    const models = new Map<string, Record<string, unknown>>()
    const target = {
      update: (_id: string, fn: (provider: Record<string, unknown>) => void) => fn({}),
      models: {
        update: (_pid: string, mid: string, fn: (model: Record<string, unknown>) => void) => {
          const key = String(mid)
          const draft = models.get(key) ?? { id: mid }
          models.set(key, draft)
          fn(draft)
        },
      },
    }
    ClaudeCodeModels.applyCatalog(target as never, {
      retired: new Map([
        ["claude-opus-4-8", { served: "claude-opus-5" }],
        // A stale KV record for an id we don't curate must not conjure a row.
        ["claude-opus-4-1", { served: "claude-opus-5" }],
      ]),
      discovered: [
        { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
        { value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable" },
        { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1 (latest)" },
        { value: "claude-fable-5", displayName: "Fable 5" },
        { value: "claude-opus-5", displayName: "Opus 5" },
      ],
    })

    expect(models.get("claude-opus-4-8")?.enabled).toBe(false)
    expect(models.has("claude-opus-4-1")).toBe(false)
    expect(models.get("claude-sonnet-4-5")?.enabled).toBe(true)

    // Curated alias refreshed in place; "default" skipped; new picker row
    // appended after the curated set so `catalog.model.small` ordering holds.
    expect(models.get("sonnet")?.name).toBe("Claude Sonnet 5 (latest)")
    expect(models.get("fable")?.name).toBe("Claude Fable 5.1 (latest)")
    expect(models.get("claude-fable-5")?.name).toBe("Claude Fable 5")
    expect(models.get("claude-opus-5")?.name).toBe("Claude Opus 5")
    expect(models.has("default")).toBe(false)
    const added = models.get("claude-fable-5[1m]")
    expect(added?.name).toBe("Claude Fable 5 1M")
    expect(added?.package).toBe(ClaudeCodeModels.SENTINEL_PACKAGE)
    expect(String(added?.family)).toBe("claude-fable")
    expect((added?.limit as { context: number }).context).toBe(1_000_000)
    expect([...models.keys()].indexOf("claude-fable-5[1m]")).toBeGreaterThan([...models.keys()].indexOf("haiku"))
  })

  it("projects the installed CLI's init-only picker inventory without inventing absent versions", () => {
    const models = new Map<string, string>()
    ClaudeCodeModels.applyCatalog(
      {
        update: (_id: unknown, fn: (draft: Record<string, unknown>) => void) => fn({}),
        models: {
          update: (_provider: unknown, id: string, fn: (draft: Record<string, unknown>) => void) => {
            const draft = { name: models.get(id) ?? "" }
            fn(draft)
            models.set(id, String(draft.name))
          },
        },
      } as never,
      {
        discovered: [
          { value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default (recommended)" },
          { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus (1M context)" },
          { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
          { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
          { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
        ],
      },
    )
    expect(models.get("opus[1m]")).toBe("Claude Opus 5.5 1M (latest)")
    expect(models.get("opus")).toBe("Claude Opus 5.5 (latest)")
    expect(models.get("fable")).toBe("Claude Fable 5.1 (latest)")
    expect(models.get("claude-fable-5-1[1m]")).toBe("Claude Fable 5.1 1M")
    expect(models.get("claude-fable-5-1")).toBe("Claude Fable 5.1")
    expect(models.get("claude-fable-5")).toBe("Claude Fable 5")
    expect(models.get("claude-opus-5-5")).toBe("Claude Opus 5.5")
    expect(models.get("sonnet")).toBe("Claude Sonnet 5 (latest)")
    expect(models.has("default")).toBe(false)
    expect(models.has("claude-fable-5-2")).toBe(false)
  })

  it("uses a reported Fable alias in preference to inferring one from the versioned row", () => {
    const models = new Map<string, string>()
    ClaudeCodeModels.applyCatalog(
      {
        update: (_id: unknown, fn: (draft: Record<string, unknown>) => void) => fn({}),
        models: {
          update: (_provider: unknown, id: string, fn: (draft: Record<string, unknown>) => void) => {
            const draft = { name: models.get(id) ?? "" }
            fn(draft)
            models.set(id, String(draft.name))
          },
        },
      } as never,
      {
        discovered: [
          { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
          { value: "fable", resolvedModel: "claude-fable-5", displayName: "Fable" },
        ],
      },
    )
    expect(models.get("fable")).toBe("Claude Fable 5 (latest)")
    expect(models.get("claude-fable-5")).toBe("Claude Fable 5")
  })

  it("updates missing family aliases from newer picker versions without hardcoding a generation", () => {
    const models = new Map<string, { name: string; limit?: { context: number } }>()
    const target = {
      update: (_id: unknown, fn: (draft: Record<string, unknown>) => void) => fn({}),
      models: {
        update: (_provider: unknown, id: string, fn: (draft: Record<string, unknown>) => void) => {
          const draft = models.get(id) ?? { name: "" }
          fn(draft)
          models.set(id, draft)
        },
      },
    }
    ClaudeCodeModels.applyCatalog(target as never, {
      discovered: [
        { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
        { value: "claude-fable-6[1m]", resolvedModel: "claude-fable-6", displayName: "Fable 6" },
        { value: "opus[1m]", resolvedModel: "claude-opus-6[1m]", displayName: "Opus 1M" },
      ],
    })
    expect(models.get("fable")).toMatchObject({ name: "Claude Fable 6 (latest)", limit: { context: 1_000_000 } })
    expect(models.get("opus")).toMatchObject({ name: "Claude Opus 6 (latest)", limit: { context: 200_000 } })
    expect(models.get("claude-fable-5-1[1m]")?.name).toBe("Claude Fable 5.1 1M")
    // Equal generations with different wire ids cannot establish the target.
    models.clear()
    ClaudeCodeModels.applyCatalog(target as never, {
      discovered: [
        { value: "claude-fable-6-20260901", resolvedModel: "claude-fable-6-20260901" },
        { value: "claude-fable-6-20260902", resolvedModel: "claude-fable-6-20260902" },
      ],
    })
    expect(models.get("fable")?.name).toBe("Claude Fable")
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
    const result = ClaudeCodeExecutable.resolveWith({
      env: { PATH: "/usr/bin" },
      platform: "linux",
      filesystem: fs([]),
    })
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
