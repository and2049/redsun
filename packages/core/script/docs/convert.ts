import path from "path"

export const ROOT = "services/www/src/docs/content"
export const DOCS_URL = "https://opencode.ai/v2/docs"
export const EXCLUDED = [/^console(\/|$)/, /^index$/]

export const excluded = (id: string) => EXCLUDED.some((pattern) => pattern.test(id))

type Segment = { readonly code: boolean; readonly text: string }

export function segments(text: string): Segment[] {
  const out: Segment[] = []
  let code = false
  let buffer: string[] = []
  const flush = () => {
    if (buffer.length) out.push({ code, text: buffer.join("\n") })
    buffer = []
  }
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (code) {
        buffer.push(line)
        flush()
        code = false
        continue
      }
      flush()
      code = true
    }
    buffer.push(line)
  }
  flush()
  return out
}

export function frontmatter(text: string): { readonly title?: string; readonly body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) return { body: text }
  const title = /^title:\s*"?([^"\n]*)"?\s*$/m.exec(match[1])?.[1]
  return { title, body: text.slice(match[0].length) }
}

const label = (type?: string) => (type ? type[0].toUpperCase() + type.slice(1) : "Note")

export function callouts(text: string) {
  return text.replace(/<Callout(?:\s+type="(\w+)")?>\s*([\s\S]*?)\s*<\/Callout>/g, (_, type, body: string) => {
    const lines = body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    return [`> **${label(type)}:** ${lines[0]}`, ...lines.slice(1).map((line) => `> ${line}`)].join("\n")
  })
}

export function cards(text: string) {
  return text
    .replace(/^[ \t]*<\/?CardGroup[^>]*>[ \t]*\n?/gm, "")
    .replace(
      /^[ \t]*<Card title="([^"]*)" href="([^"]*)">\s*([\s\S]*?)\s*<\/Card>/gm,
      (_, title, href, body: string) => {
        return `- [${title}](${href}): ${body.replace(/\s+/g, " ").trim()}`
      },
    )
}

export function resolve(route: string, from: string, pages: ReadonlySet<string>) {
  const id = route.replace(/^\/|\/$/g, "")
  const target = [`${id}/index`, id].find((candidate) => pages.has(candidate))
  if (!target) return `${DOCS_URL}${route === "/" ? "" : route}`
  const relative = path.posix.relative(path.posix.dirname(from), target)
  return `${relative || path.posix.basename(target)}.md`
}

export function links(text: string, from: string, pages: ReadonlySet<string>) {
  return text.replace(
    /\]\((\/[^)\s#]*)(#[^)]*)?\)/g,
    (_, route: string, anchor: string | undefined) => `](${resolve(route, from, pages)}${anchor ?? ""})`,
  )
}

const BRAND: ReadonlyArray<readonly [RegExp, string]> = [
  [/OpenCode is used by millions every day\. /g, ""],
  [/\bopencode\.json(c?)\b/g, "redsun.json$1"],
  [/\.opencode\b/g, ".redsun"],
  [/((?:\.config|\.local\/share|\.local\/state|\.cache|XDG_[A-Z]+_HOME|\/var\/run)\/)opencode\b/g, "$1redsun"],
  [/\bopencode\/repos\b/g, "redsun/repos"],
  [/\bopencode2\b/g, "redsun"],
  [/"opencode", "serve"/g, '"redsun", "serve"'],
  [/(^|[\s`$])opencode(?=\s+(?:[a-z][\w-]*|--?\w))/gm, "$1redsun"],
  [/\bOpenCode 2(?:\.0)?\b/g, "redsun"],
  [/\bOpenCode 1\b/g, "OpenCode V1"],
  [/\bOpenCode\b(?![.\w])(?! (?:Console|Zen|Go|V1)\b)/g, "redsun"],
  [/github\.com\/anomalyco\/opencode\b/g, "github.com/and2049/redsun"],
  [/\bopencode\.db\b/g, "redsun-release.db"],
  [/\ban redsun\b/g, "a redsun"],
  [/When omitted, `update` defaults to `"notify"`\./g, 'When omitted, `update` defaults to `"auto"`.'],
]

export function brand(text: string) {
  return BRAND.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
}

export function convert(input: { readonly id: string; readonly text: string; readonly pages: ReadonlySet<string> }) {
  const { title, body } = frontmatter(input.text)
  const prose = segments(body)
    .map((segment) => (segment.code ? segment.text : links(cards(callouts(segment.text)), input.id, input.pages)))
    .join("\n")
  const heading = title ? `# ${title}\n\n` : ""
  return brand(`${heading}${prose.trim()}\n`)
}
