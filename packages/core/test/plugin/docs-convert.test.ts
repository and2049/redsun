import { describe, expect, test } from "bun:test"
import { brand, callouts, cards, convert, excluded, frontmatter, links, segments } from "../../script/docs/convert"

const pages = new Set(["config", "build/plugins/index", "build/plugins/cli", "cli/keybinds"])

describe("docs convert", () => {
  test("excludes the intro and console pages", () => {
    expect(excluded("index")).toBe(true)
    expect(excluded("console/go")).toBe(true)
    expect(excluded("console")).toBe(true)
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
  })

  test("brand keeps package names, env vars, identifiers, urls, and upstream products", () => {
    const kept = [
      'import { Plugin } from "@opencode/plugin/tui"',
      "OPENCODE_LOG_LEVEL=DEBUG",
      "OpenCode.make OpenCodeClient OpenCodeEvent OpenCode.create",
      "https://opencode.ai/config.json",
      "OpenCode Go and OpenCode Console and OpenCode Zen",
      "const opencode = await OpenCode.create()\nawait opencode.sessions.list()",
      '"model": "opencode/gpt-5.5"',
      '"plugins": ["-opencode.provider.ollama"]',
      "opencode-acme-plugin",
      "`opencode/autoinvoke`",
      "opencode.log",
    ]
    for (const text of kept) expect(brand(text)).toBe(text)
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
    expect(convert({ id: "cli/keybinds", text, pages })).toBe(
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
