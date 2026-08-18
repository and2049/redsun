import { describe, expect, it } from "bun:test"
import { RedsunProjectMemory } from "@opencode-ai/core/plugin/redsun/project-memory"

describe("RedsunProjectMemory", () => {
  it("reads project memory from .redsun/memory.md", () => {
    expect(RedsunProjectMemory.RELATIVE_PATH).toContain(".redsun")
    expect(RedsunProjectMemory.RELATIVE_PATH).toContain("memory.md")
  })

  it("registers under a redsun-owned plugin id", () => {
    expect(RedsunProjectMemory.Plugin.id).toBe("redsun.instruction.project-memory")
  })
})
