import { describe, expect, test } from "bun:test"
import path from "node:path"

// Delegated agent runtimes are their own packages and reach core only through plugin hooks.
// These lists are a ratchet: each stage of .redsun/plans/delegated-runtime-hooks.md removes
// entries, and a new reference outside the plugin fails until it is justified here.

const packages = path.resolve(import.meta.dir, "../..")
const RUNTIMES = ["runtime-acp"]

const scan = async (pattern: RegExp) => {
  const hits: string[] = []
  const glob = new Bun.Glob("{core,tui,schema,protocol,server,cli}/src/**/*.{ts,tsx}")
  for await (const file of glob.scan({ cwd: packages })) {
    if (file.includes("/generated/")) continue
    // The Claude Agent provider drives Claude Code through its SDK and names it by its own identifiers.
    if (file.startsWith("core/src/plugin/provider/claude-agent/")) continue
    if (pattern.test(await Bun.file(path.join(packages, file)).text())) hits.push(file)
  }
  return hits.sort()
}

// Permanent: the resolver alias that keeps sessions saved on the retired `claude-code` provider
// running on `claude-agent`, and the IDE integration's upstream `x-claude-code-ide-authorization`
// header, which is unrelated.
const PERMANENT = ["core/src/model-resolver.ts", "tui/src/context/editor.ts"]

const PENDING: string[] = []

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

  test("the retired Claude-specific permission modes are gone", async () => {
    expect(await scan(/claude_auto|native_auto/)).toEqual([])
  })
})
