import { describe, expect, test } from "bun:test"
import path from "node:path"

// Delegated agent runtimes (Claude Code today) must reach core only through plugin hooks.
// These lists are a ratchet: each stage of .redsun/plans/delegated-runtime-hooks.md removes
// entries, and a new reference outside the plugin fails until it is justified here.

const packages = path.resolve(import.meta.dir, "../..")
const PLUGIN_DIR = "core/src/plugin/redsun/claude-code/"

const scan = async (pattern: RegExp) => {
  const hits: string[] = []
  const glob = new Bun.Glob("{core,tui,schema,protocol,server,cli}/src/**/*.{ts,tsx}")
  for await (const file of glob.scan({ cwd: packages })) {
    if (file.startsWith(PLUGIN_DIR) || file.includes("/generated/")) continue
    if (pattern.test(await Bun.file(path.join(packages, file)).text())) hits.push(file)
  }
  return hits.sort()
}

// Permanent: bundled registration, the `claude_code` config key (kept by decision D3), and the
// IDE integration's upstream `x-claude-code-ide-authorization` header, which is unrelated.
const PERMANENT = [
  "core/src/config/normalize.ts",
  "core/src/plugin/internal.ts",
  "schema/src/config.ts",
  "schema/src/config/claude-code.ts",
  "tui/src/context/editor.ts",
]

// Pending removal by the stage named beside each entry.
const PENDING = [
  "tui/src/app.tsx", // stage 4
  "tui/src/context/permission.tsx", // stage 4
  "tui/src/routes/session/index.tsx", // stage 4
]

// `claude_auto` becomes the runtime-declared `native_auto` in stage 4.
const PERMISSION_MODE_PENDING = [
  "core/src/permission.ts",
  "protocol/src/groups/permission.ts",
  "schema/src/permission.ts",
  "tui/src/app.tsx",
  "tui/src/component/workspace-status.tsx",
  "tui/src/context/permission.tsx",
]

// Plugin files that still reach into core instead of `ctx`; stage 3 of the plan empties this.
const PLUGIN_CORE_IMPORTS_PENDING = [
  "host-files.ts", // 3d: instruction bounding, project memory policy
  "provider.ts", // 3b-3e: core services
  "subagent-events.ts", // 3e: child transcript events
]

describe("delegated runtime boundaries", () => {
  test("the Claude Code plugin imports nothing outside its directory except where pending", async () => {
    const hits: string[] = []
    const glob = new Bun.Glob("*.ts")
    for await (const file of glob.scan({ cwd: path.join(packages, PLUGIN_DIR) }))
      if (/^import [^\n]*from "\.\.\//m.test(await Bun.file(path.join(packages, PLUGIN_DIR, file)).text()))
        hits.push(file)
    expect(hits.sort()).toEqual(PLUGIN_CORE_IMPORTS_PENDING)
  })

  test("Claude Code is referenced outside its plugin only where allowed", async () => {
    expect(await scan(/ClaudeCode|claude-code|claude_code/)).toEqual([...PERMANENT, ...PENDING].sort())
  })

  test("the Claude-specific permission mode is not spreading", async () => {
    expect(await scan(/claude_auto/)).toEqual([...PERMISSION_MODE_PENDING].sort())
  })
})
