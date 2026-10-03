import path from "path"

export const ROOT = "services/www/src/docs/content"
export const DOCS_URL = "https://opencode.ai/v2/docs"
// REDSUN: V1 migration guides and the embedding SDK (redsun ships no `@opencode/sdk`) are not vendored.
export const EXCLUDED = [/^console(\/|$)/, /^index$/, /(^|\/)migrate-v1$/, /^build\/sdk(\/|$)/]

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
  [/(?<![\w-])\.opencode\b/g, ".redsun"],
  [/((?:\.config|\.local\/share|\.local\/state|\.cache|XDG_[A-Z]+_HOME|\/var\/run)\/)opencode\b/g, "$1redsun"],
  [/\bopencode\/repos\b/g, "redsun/repos"],
  [/\bopencode2\b/g, "redsun"],
  [/"opencode", "serve"/g, '"redsun", "serve"'],
  [/(^|[\s`$(])opencode(?=\s+(?:[a-z][\w-]*|--?\w))/gm, "$1redsun"],
  [/\bOpenCode 2(?:\.0)?\b/g, "redsun"],
  [/\bOpenCode 1\b/g, "OpenCode V1"],
  [/\bOpenCode\b(?!\.?\w)(?! (?:Console|Zen|Go|V1|team)\b)/g, "redsun"],
  [/github\.com\/anomalyco\/opencode\b/g, "github.com/and2049/redsun"],
  [/\bopencode\.db\b/g, "redsun-release.db"],
  [/\ban redsun\b/g, "a redsun"],
  [/When omitted, `update` defaults to `"notify"`\./g, 'When omitted, `update` defaults to `"auto"`.'],
]

export function brand(text: string) {
  return BRAND.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
}

// REDSUN: upstream sections and lines that are wrong for redsun: V1 guidance, and features
// redsun does not ship (mini, the desktop app and its browser, the web UI). Both apply to
// branded text, and a rule that no longer matches fails the sync instead of letting the
// upstream text through.
export const SECTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "build/plugins/index": ["Support V1"],
  "cli/commands": ["mini"],
  "cli/config": ["Mini"],
  "cli/index": ["Mini"],
  "cli/keybinds": ["Mini"],
  compaction: ["Migration"],
  tools: ["Browser"],
}

export const PATCHES: Readonly<Record<string, ReadonlyArray<readonly [RegExp | string, string]>>> = {
  agents: [[" in new V2 agent configuration.", " in agent configuration."]],
  attachments: [
    [
      " In the desktop\nor web client, choose **Attach file**, paste a file, or drag it into the prompt.",
      " In the TUI, paste\na file or image into the prompt, or mention a file with `@`.",
    ],
    [
      "Desktop file-picker selections can total up to 20 MiB. Other interfaces may\napply lower client-side limits.\n\n",
      "",
    ],
    [/^\| Desktop picker selection .*\n/m, ""],
  ],
  "build/index": [
    ["Build on top of it to create", "Build on top of redsun to create"],
    [/,\n\[clients\]\(client\/effect\.md\), and \[embedded apps\]\([^)]*\)\./, " and\n[clients](client/effect.md)."],
    ["used by the TUI and desktop app,", "used by the TUI,"],
    [/^- \[Embed it\].*\n?/m, ""],
  ],
  "build/plugins/index": [[/^Migrating an existing OpenCode V1 plugin\?.*\n\n/m, ""]],
  "cli/commands": [
    [
      "      - run: npm install --global @opencode/cli\n",
      '      - run: curl -fsSL https://github.com/and2049/redsun/releases/latest/download/install | bash -s -- --no-modify-path\n      - run: echo "$HOME/.redsun/bin" >> "$GITHUB_PATH"\n',
    ],
    [
      "Upgrade to a specific version with a specific package manager.",
      "Upgrade to a specific version with a specific installation method.",
    ],
    ["$ redsun upgrade 1.18.15 --method bun", "$ redsun upgrade <version> --method curl"],
  ],
  "cli/index": [
    [
      /^- Package-manager installations use the detected package manager\. Curl installations print the final command to remove\n  the executable manually\.$/m,
      "- Curl and PowerShell installations print the final command to remove the executable manually.",
    ],
  ],
  "cli/theme": [["The default theme is `opencode`.", "The default theme is `dusk`."]],
  "cli/web": [
    [
      "redsun ships with a web ui that is served from the same server that powers the\nTUI. It's available by default and password protected.",
      "redsun does not ship a web UI. The server that powers the TUI is password\nprotected, and browser or remote clients connect to it over HTTP.",
    ],
  ],
  permissions: [[/^> \*\*Warning:\*\* V1 uses different field and action names\.[^\n]*\n(?:>[^\n]*\n)*\n/m, ""]],
}

const HEADING = /^(#{2,6}) (.+)$/

/** Removes each named section: its heading through the next heading at the same or a higher level. */
export function dropSections(text: string, titles: ReadonlyArray<string>, id = "") {
  const lines = text.split("\n")
  const kept: string[] = []
  const found = new Set<string>()
  let fence = false
  let dropping = 0
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence
    const heading = fence ? undefined : HEADING.exec(line)
    if (heading && dropping && heading[1].length <= dropping) dropping = 0
    if (heading && !dropping && titles.includes(heading[2])) {
      found.add(heading[2])
      dropping = heading[1].length
    }
    if (!dropping) kept.push(line)
  }
  const missing = titles.filter((title) => !found.has(title))
  if (missing.length) throw new Error(`docs ${id}: sections not found: ${missing.join(", ")}`)
  return kept.join("\n")
}

export function patch(text: string, patches: ReadonlyArray<readonly [RegExp | string, string]>, id = "") {
  return patches.reduce((out, [pattern, replacement]) => {
    const next = out.replace(pattern, replacement)
    if (next === out) throw new Error(`docs ${id}: patch did not match: ${pattern}`)
    return next
  }, text)
}

export function convert(input: { readonly id: string; readonly text: string; readonly pages: ReadonlySet<string> }) {
  const { title, body } = frontmatter(input.text)
  const prose = segments(body)
    .map((segment) => (segment.code ? segment.text : links(cards(callouts(segment.text)), input.id, input.pages)))
    .join("\n")
  const heading = title ? `# ${title}\n\n` : ""
  const branded = brand(`${heading}${prose.trim()}\n`)
  const sections = SECTIONS[input.id]
  return patch(sections ? dropSections(branded, sections, input.id) : branded, PATCHES[input.id] ?? [], input.id)
}
