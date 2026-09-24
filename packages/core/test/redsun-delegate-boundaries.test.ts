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
// The legacy substitution-notice key in schema/src/delegate.ts keeps persisted rows readable.
const PERMANENT = [
  "core/src/config/normalize.ts",
  "core/src/plugin/internal.ts",
  "schema/src/config.ts",
  "schema/src/config/claude-code.ts",
  "schema/src/delegate.ts",
  "tui/src/context/editor.ts",
]

const PENDING: string[] = []

// `claude_auto` is now `native_auto`; core still reads a stored `claude_auto` selection.
const PERMISSION_MODE_COMPAT = ["core/src/permission.ts"]

describe("delegated runtime boundaries", () => {
  test("the Claude Code plugin reaches core only through ctx", async () => {
    const hits: string[] = []
    const glob = new Bun.Glob("*.ts")
    for await (const file of glob.scan({ cwd: path.join(packages, PLUGIN_DIR) })) {
      const source = await Bun.file(path.join(packages, PLUGIN_DIR, file)).text()
      for (const [, specifier] of source.matchAll(/(?:from|import\()\s*"([^"]+)"/g))
        if (specifier!.startsWith("../") || specifier!.startsWith("@opencode/core")) hits.push(`${file}: ${specifier}`)
    }
    expect(hits).toEqual([])
  })

  test("Claude Code is referenced outside its plugin only where allowed", async () => {
    expect(await scan(/ClaudeCode|claude-code|claude_code/)).toEqual([...PERMANENT, ...PENDING].sort())
  })

  test("the Claude-specific permission mode is not spreading", async () => {
    expect(await scan(/claude_auto/)).toEqual(PERMISSION_MODE_COMPAT)
  })
})
