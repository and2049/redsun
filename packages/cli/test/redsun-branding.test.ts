import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const roots = ["../cli/src", "../tui/src"].map((dir) => path.resolve(import.meta.dirname, "..", dir))
const allowed = [/OpenCode Console/, /Connecting to OpenCode\.\.\./]
const leak = /(["'`>][^"'`<\n]*\bOpenCode\b[^"'`<\n]*["'`<])|\bopencode mini\b|opencode \/ /

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry)
    if (statSync(file).isDirectory()) yield* files(file)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield file
  }
}

test("user-facing strings in the cli and tui name redsun, not OpenCode", () => {
  const leaks: string[] = []
  for (const root of roots) {
    for (const file of files(root)) {
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (/^\s*(\/\/|\*|import\b)/.test(line)) return
          if (!leak.test(line) || allowed.some((pattern) => pattern.test(line))) return
          leaks.push(`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`)
        })
    }
  }
  expect(leaks).toEqual([])
})
