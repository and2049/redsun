import { describe, expect, test } from "bun:test"
import {
  brand,
  callouts,
  cards,
  convert,
  dropSections,
  excluded,
  frontmatter,
  links,
  patch,
  segments,
} from "../../script/docs/convert"

const pages = new Set(["config", "build/plugins/index", "build/plugins/cli", "cli/keybinds"])

describe("docs convert", () => {
  test("excludes the intro, console, V1 migration, and SDK pages", () => {
    expect(excluded("index")).toBe(true)
    expect(excluded("console/go")).toBe(true)
    expect(excluded("console")).toBe(true)
    expect(excluded("migrate-v1")).toBe(true)
    expect(excluded("build/plugins/migrate-v1")).toBe(true)
    expect(excluded("build/sdk")).toBe(true)
    expect(excluded("build/sdk/cloudflare")).toBe(true)
    expect(excluded("build/plugins")).toBe(false)
    expect(excluded("config")).toBe(false)
    expect(excluded("cli/index")).toBe(false)
  })

  test("frontmatter title becomes the heading", () => {
    expect(frontmatter('---\ntitle: "CLI"\n---\n\nbody')).toEqual({ title: "CLI", body: "\nbody" })
    expect(frontmatter("no frontmatter")).toEqual({ body: "no frontmatter" })
  })

  test("segments keep code fences separate from prose", () => {
    const parts = segments("a\n```ts\n<Callout>\n```\nb")
    expect(parts.map((part) => part.code)).toEqual([false, true, false])
    expect(parts[1].text).toBe("```ts\n<Callout>\n```")
  })

  test("callouts become labelled blockquotes", () => {
    expect(callouts('<Callout type="warning">\n  one\n  two\n</Callout>')).toBe("> **Warning:** one\n> two")
    expect(callouts("<Callout>only</Callout>")).toBe("> **Note:** only")
  })

  test("cards become link list items", () => {
    const input =
      '<CardGroup cols={1}>\n  <Card title="Build" href="/build/plugins">\n    Make\n    things.\n  </Card>\n</CardGroup>'
    expect(cards(input)).toBe("- [Build](/build/plugins): Make things.\n")
  })

  test("links resolve to relative pages or the online docs", () => {
    expect(links("[x](/config)", "cli/keybinds", pages)).toBe("[x](../config.md)")
    expect(links("[x](/build/plugins#hooks)", "config", pages)).toBe("[x](build/plugins/index.md#hooks)")
    expect(links("[x](/build/plugins/cli)", "build/plugins/index", pages)).toBe("[x](cli.md)")
    expect(links("[x](/api)", "config", pages)).toBe("[x](https://opencode.ai/v2/docs/api)")
    expect(links("[x](/console/go)", "config", pages)).toBe("[x](https://opencode.ai/v2/docs/console/go)")
  })

  test("brand renames the product, binary, config files, and directories", () => {
    expect(brand("OpenCode reads opencode.json and opencode.jsonc")).toBe("redsun reads redsun.json and redsun.jsonc")
    expect(brand("project `.opencode` and `.opencode/agents`")).toBe("project `.redsun` and `.redsun/agents`")
    expect(brand("~/.config/opencode/cli.json ~/.local/share/opencode/log $XDG_CONFIG_HOME/opencode/x")).toBe(
      "~/.config/redsun/cli.json ~/.local/share/redsun/log $XDG_CONFIG_HOME/redsun/x",
    )
    expect(brand("$ opencode2 plugin add x\n`opencode serve --service`\nopencode --standalone")).toBe(
      "$ redsun plugin add x\n`redsun serve --service`\nredsun --standalone",
    )
    expect(brand('command: ["opencode", "serve"]')).toBe('command: ["redsun", "serve"]')
    expect(brand("OpenCode 2 replaces OpenCode 1's binary; OpenCode's docs")).toBe(
      "redsun replaces OpenCode V1's binary; redsun's docs",
    )
    expect(brand("https://github.com/anomalyco/opencode/issues")).toBe("https://github.com/and2049/redsun/issues")
    expect(brand("an OpenCode server")).toBe("a redsun server")
    expect(brand("OpenCode is used by millions every day. Build on it.")).toBe("Build on it.")
    expect(brand('When omitted, `update` defaults to `"notify"`.')).toBe('When omitted, `update` defaults to `"auto"`.')
    expect(brand("without restarting OpenCode.\nreserved by OpenCode.")).toBe(
      "without restarting redsun.\nreserved by redsun.",
    )
    expect(brand('sqlite3 "$(opencode debug paths db)"')).toBe('sqlite3 "$(redsun debug paths db)"')
  })

  test("brand keeps package names, env vars, identifiers, urls, and upstream products", () => {
    const kept = [
      'import { Plugin } from "@opencode/plugin/tui"',
      "OPENCODE_LOG_LEVEL=DEBUG",
      "OpenCode.make OpenCodeClient OpenCodeEvent OpenCode.create",
      "https://opencode.ai/config.json",
      "OpenCode Go and OpenCode Console and OpenCode Zen",
      "models tested by the OpenCode team",
      "https://console.opencode.ai",
      "`metadata.opencode/autoinvoke`",
      "const opencode = await OpenCode.create()\nawait opencode.sessions.list()",
      '"model": "opencode/gpt-5.5"',
      '"plugins": ["-opencode.provider.ollama"]',
      "opencode-acme-plugin",
      "`opencode/autoinvoke`",
      "opencode.log",
    ]
    for (const text of kept) expect(brand(text)).toBe(text)
  })

  test("dropSections removes a section through the next heading at its level, ignoring fenced lines", () => {
    const text = [
      "# Page",
      "## Keep",
      "a",
      "## Mini",
      "b",
      "```sh",
      "## not a heading",
      "```",
      "### Sub",
      "c",
      "## Next",
      "d",
    ]
    expect(dropSections(text.join("\n"), ["Mini"])).toBe(["# Page", "## Keep", "a", "## Next", "d"].join("\n"))
    expect(() => dropSections(text.join("\n"), ["Gone"], "page")).toThrow("sections not found: Gone")
  })

  test("patch fails when upstream text no longer matches", () => {
    expect(patch("one two", [["two", "three"]])).toBe("one three")
    expect(() => patch("one two", [[/four/, "five"]], "page")).toThrow("patch did not match")
  })

  test("convert applies prose rules outside code and brand rules everywhere", () => {
    const text = [
      "---",
      'title: "Config"',
      "---",
      "",
      "OpenCode reads [config](/config).",
      "",
      '<Callout type="tip">Use `.opencode/`.</Callout>',
      "",
      "```json",
      '{ "$schema": "https://opencode.ai/config.json", "file": "opencode.json" }',
      "<Callout>",
      "```",
    ].join("\n")
    expect(convert({ id: "cli/tui", text, pages })).toBe(
      [
        "# Config",
        "",
        "redsun reads [config](../config.md).",
        "",
        "> **Tip:** Use `.redsun/`.",
        "",
        "```json",
        '{ "$schema": "https://opencode.ai/config.json", "file": "redsun.json" }',
        "<Callout>",
        "```",
        "",
      ].join("\n"),
    )
  })
})
