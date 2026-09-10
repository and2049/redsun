import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { ROOT, convert, excluded } from "./convert"

const ref = process.argv[2] ?? "upstream/beta"
const out = path.join(import.meta.dir, "../../src/plugin/skill/docs")
const root = path.join(import.meta.dir, "../../../..")
const sha = (await $`git rev-parse ${ref}`.cwd(root).text()).trim()
const ids = (await $`git ls-tree -r --name-only ${ref} -- ${ROOT}`.cwd(root).text())
  .trim()
  .split("\n")
  .filter((file) => file.endsWith(".mdx"))
  .map((file) => file.slice(ROOT.length + 1, -".mdx".length))
const pages = new Set(ids)
const kept: string[] = []

await fs.rm(out, { recursive: true, force: true })
for (const id of ids.filter((id) => !excluded(id)).toSorted()) {
  const text = await $`git show ${ref}:${ROOT}/${id}.mdx`.cwd(root).text()
  const content = convert({ id, text, pages })
  if (!content.trim().includes("\n")) continue
  const target = path.join(out, `${id}.md`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
  kept.push(id)
}
await fs.writeFile(path.join(out, "SOURCE"), `${sha}\n`)

const imports = kept.map((id, index) => `import p${index} from "./${id}.md" with { type: "text" }`)
const entries = kept.map((id, index) => `  { path: "${id}.md", content: p${index} },`)
await fs.writeFile(
  path.join(out, "index.ts"),
  [
    '/// <reference path="../../../markdown.d.ts" />',
    "",
    ...imports,
    "",
    `export const source = "${sha}"`,
    "",
    "export const pages: ReadonlyArray<{ readonly path: string; readonly content: string }> = [",
    ...entries,
    "]",
    "",
  ].join("\n"),
)
await $`bun run prettier --write ${out}`.cwd(root)
console.log(`synced ${kept.length} pages from ${ref} (${sha.slice(0, 8)}) to ${out}`)
