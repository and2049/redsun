import { describe, expect, test } from "bun:test"
import { toolTeaser } from "../../src/util/tool-teaser"

describe("toolTeaser", () => {
  test("short single-line detail stays inline", () => {
    const result = toolTeaser({ detail: "Read [file_path=notes.txt]", output: "", width: 80 })
    expect(result.collapsible).toBe(false)
    expect(result.teaser).toBe("Read [file_path=notes.txt]")
  })

  test("multi-line detail collapses to a flattened teaser", () => {
    const detail = 'Edit [file_path=a.ts, old_string=import { a } from "b"\nimport { c } from "d"\nmore]'
    const result = toolTeaser({ detail, output: "", width: 200 })
    expect(result.collapsible).toBe(true)
    expect(result.teaser).not.toContain("\n")
    expect(result.teaser).toContain("Edit [file_path=a.ts")
  })

  test("overflowing single-line detail collapses with a trailing ellipsis", () => {
    const detail = `Grep [pattern=${"x".repeat(300)}]`
    const result = toolTeaser({ detail, output: "", width: 80 })
    expect(result.collapsible).toBe(true)
    expect(result.teaser.endsWith("…")).toBe(true)
    // One row: prefix (5) + teaser + " (click to expand)" (18) fits width 80.
    expect(result.teaser.length).toBeLessThanOrEqual(80 - 5 - 18 + 1)
  })

  test("any output makes the call collapsible and joins the teaser", () => {
    const result = toolTeaser({ detail: "MyTool [arg=1]", output: "ok", width: 80 })
    expect(result.collapsible).toBe(true)
    expect(result.teaser).toBe("MyTool [arg=1] ok")
  })

  test("very narrow terminals keep a minimum teaser width", () => {
    const result = toolTeaser({ detail: "Tool [value=aaaaaaaaaaaaaaaaaaaa]", output: "", width: 10 })
    expect(result.teaser).toBe("Tool [valu…")
  })
})
