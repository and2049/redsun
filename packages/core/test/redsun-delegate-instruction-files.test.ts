import { describe, expect, it } from "bun:test"
import { DelegateHost } from "@opencode/core/delegate-host"
import { RedsunProjectMemory } from "@opencode/core/plugin/redsun/project-memory"

const project = "/repo"
const long = Array.from({ length: 400 }, (_, index) => `rule ${index}`).join("\n")

describe("DelegateHost.liveTokens", () => {
  it("normalizes a runtime's live usage as the stream's finish usage is", () => {
    expect(
      DelegateHost.liveTokens({
        inputTokens: { total: 1045, noCache: 5, cacheRead: 1000, cacheWrite: 40 },
        outputTokens: { total: 30, text: undefined, reasoning: 10 },
      }),
    ).toEqual({ input: 5, output: 20, reasoning: 10, cache: { read: 1000, write: 40 } })
    expect(
      DelegateHost.liveTokens({
        inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: undefined, text: undefined, reasoning: undefined },
      }),
    ).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  })
})

describe("DelegateHost.instructionFiles", () => {
  it("bounds every delivered file to the configured size with a read pointer", () => {
    const [agents] = DelegateHost.instructionFiles([{ path: "/repo/AGENTS.md", content: long }], {
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
      DelegateHost.instructionFiles([{ path: "/repo/AGENTS.md", content: "short" }], { project, maxChars: 600 }),
    ).toEqual([{ path: "/repo/AGENTS.md", content: "short" }])
  })

  it("prefixes the maintenance policy to project memory only, after bounding", () => {
    const memory = `${project}/${RedsunProjectMemory.RELATIVE_PATH}`
    const files = DelegateHost.instructionFiles(
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
