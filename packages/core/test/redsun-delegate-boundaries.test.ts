import { describe, expect, test } from "bun:test"
import path from "node:path"

// Delegated agent runtimes are their own packages and reach core only through plugin hooks.
// These lists are a ratchet: each stage of .redsun/plans/delegated-runtime-hooks.md removes
// entries, and a new reference outside the plugin fails until it is justified here.

const packages = path.resolve(import.meta.dir, "../..")
const RUNTIMES = ["runtime-acp", "runtime-claude-code"]

const scan = async (pattern: RegExp) => {
  const hits: string[] = []
  const glob = new Bun.Glob("{core,tui,schema,protocol,server,cli}/src/**/*.{ts,tsx}")
  for await (const file of glob.scan({ cwd: packages })) {
    if (file.includes("/generated/")) continue
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
  test.each(RUNTIMES)("%s imports nothing from core and stays inside its package", async (runtime) => {
    const hits: string[] = []
    const root = path.join(packages, runtime)
    for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: root })) {
      const source = await Bun.file(path.join(root, file)).text()
      for (const [, specifier] of source.matchAll(/(?:from|import\()\s*"([^"]+)"/g)) {
        const escapes =
          specifier!.startsWith(".") &&
          !path.resolve(root, path.dirname(file), specifier!).startsWith(path.join(root, "src") + path.sep)
        if (specifier!.startsWith("@opencode/core") || escapes) hits.push(`${file}: ${specifier}`)
      }
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
