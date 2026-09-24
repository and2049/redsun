import { describe, expect, it } from "bun:test"
import { ClaudeCodeHostFiles } from "@opencode/core/plugin/redsun/claude-code/host-files"
import { RedsunProjectMemory } from "@opencode/core/plugin/redsun/project-memory"

const project = "/repo"
const long = Array.from({ length: 400 }, (_, index) => `rule ${index}`).join("\n")

describe("ClaudeCodeHostFiles.deliver", () => {
  it("bounds every delivered file to the configured size with a read pointer", () => {
    const [agents] = ClaudeCodeHostFiles.deliver([{ path: "/repo/AGENTS.md", content: long }], {
      project,
      maxChars: 600,
    })
    expect(agents!.path).toBe("/repo/AGENTS.md")
    expect(agents!.content.length).toBeLessThan(600)
    expect(agents!.content.startsWith("rule 0\n")).toBe(true)
    expect(agents!.content).toContain("Read the remainder with the read tool: /repo/AGENTS.md offset=")
    expect(agents!.content).not.toContain("Instructions from:")
  })

  it("leaves a file within the limit untouched", () => {
    expect(
      ClaudeCodeHostFiles.deliver([{ path: "/repo/AGENTS.md", content: "short" }], { project, maxChars: 600 }),
    ).toEqual([{ path: "/repo/AGENTS.md", content: "short" }])
  })

  it("prefixes the maintenance policy to project memory only, after bounding", () => {
    const memory = `${project}/${RedsunProjectMemory.RELATIVE_PATH}`
    const files = ClaudeCodeHostFiles.deliver(
      [
        { path: memory, content: long },
        { path: "/other/.redsun/memory.md", content: "elsewhere" },
      ],
      { project, maxChars: 600 },
    )
    expect(files[0]!.content.startsWith(`${RedsunProjectMemory.POLICY}\n\nrule 0\n`)).toBe(true)
    // The policy rides outside the bound so it is never what gets truncated.
    expect(files[0]!.content.length).toBeLessThan(RedsunProjectMemory.POLICY.length + 600)
    expect(files[0]!.content).toContain("instructions truncated")
    expect(files[1]!.content).toBe("elsewhere")
  })
})
