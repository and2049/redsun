/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const hex = (ints: number[]) =>
  "#" +
  ints
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")

const CONTENT = "- first item with `code` inside\n- second item\n\nPlain paragraph here."

// OpenTUI 0.5.10 re-applied a changed syntax style to paragraph blocks but not
// to list items in top-level block mode, so after a theme change (the picker
// previews every theme it passes over) list text kept the previous theme's
// style object, which redsun then destroys. On a light theme that left the
// old dark theme's light-grey text on a light background. Covered by
// patches/@opentui%2Fcore@0.5.10.patch.
test("markdown list items follow a theme change like paragraphs do", async () => {
  await using root = await tmpdir()
  const state = path.join(root.path, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig({ theme: { name: "dusk" } })
  const [{ ConfigProvider }, { ThemeProvider, useTheme, useThemes }] = await Promise.all([
    import("../src/config"),
    import("../src/context/theme"),
  ])
  let switchTheme!: (name: string) => void
  function Doc() {
    const theme = useTheme()
    const themes = useThemes()
    switchTheme = (name) => themes.set(name)
    return (
      <markdown
        content={CONTENT}
        syntaxStyle={themes.currentSyntax()}
        streaming={false}
        internalBlockMode="top-level"
        conceal
        fg={theme.markdown.text}
        bg={theme.background.base}
      />
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts directory={root.path} paths={{ home: root.path, state, worktree: root.path }}>
        <ConfigProvider config={config}>
          <ThemeProvider source={emptyThemeSource}>
            <Doc />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 60, height: 8, kittyKeyboard: true },
  )
  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Plain paragraph"))
    // Highlighting is asynchronous; give the tree-sitter round trips time to land.
    const settle = async () => {
      for (let i = 0; i < 8; i++) {
        await new Promise((resolve) => setTimeout(resolve, 60))
        await app.renderOnce()
      }
    }
    const rows = () =>
      app.renderer.currentRenderBuffer.getSpanLines().map((line) => line.spans.filter((span) => span.text.trim()))
    const colorsOf = (needle: string) => {
      const row = rows().find((spans) => spans.some((span) => span.text.includes(needle)))
      expect(row, needle).toBeDefined()
      return row!.map((span) => hex(span.fg.toInts()))
    }

    await settle()
    switchTheme("cloud")
    await settle()
    // cloud: text #3f5c4f, markdownListItem #3f5c4f, markdownCode #7a5ea8
    expect(colorsOf("Plain paragraph")).toEqual(["#3f5c4f"])
    expect(colorsOf("second item")).toEqual(["#3f5c4f"])
    expect(colorsOf("first item")).toContain("#7a5ea8")
    for (const color of colorsOf("first item")) expect(color).not.toBe("#ffffff")

    switchTheme("glade")
    await settle()
    // glade: text #5c6a72, markdownListItem #8da101 paints the marker only.
    expect(colorsOf("second item")).toEqual(["#8da101", "#5c6a72"])
    expect(colorsOf("Plain paragraph")).toEqual(["#5c6a72"])
  } finally {
    app.renderer.destroy()
  }
})
