import { describe, expect, it } from "bun:test"
import { ClaudeCodeLanguageModel } from "../src/language-model.js"
import { ClaudeCodeModes } from "../src/modes.js"
import { ClaudeCodeProfiles } from "../src/profiles.js"
import { ClaudeCodeTurnBrief } from "../src/turn-brief.js"

const config = { executablePath: "/usr/bin/claude", cwd: "/repo" }

describe("ClaudeCodeProfiles", () => {
  it("defaults to redsun and keeps the native literal's meaning", () => {
    expect(ClaudeCodeProfiles.resolve(undefined).name).toBe("redsun")
    expect(ClaudeCodeProfiles.resolve("something-else").name).toBe("redsun")
    expect(ClaudeCodeProfiles.resolve("extended").name).toBe("extended")
    expect(ClaudeCodeProfiles.resolve("native").name).toBe("native")
  })

  it("offers native approval only where native tools exist (D5)", () => {
    expect(ClaudeCodeProfiles.PROFILES.redsun.nativeApproval).toBe(false)
    expect(ClaudeCodeProfiles.PROFILES.extended.nativeApproval).toBe(true)
    expect(ClaudeCodeProfiles.PROFILES.native.nativeApproval).toBe(true)
  })

  it("keeps plan-exit and other non-duplicates out of the duplicates table, and the alias table empty", () => {
    for (const kept of ["ExitPlanMode", "EnterPlanMode", "Monitor", "LSP", "SendMessage", "Workflow"])
      expect(ClaudeCodeProfiles.DUPLICATES[kept]).toBeUndefined()
    expect(ClaudeCodeProfiles.DUPLICATES.ToolSearch).toBe("execute")
    expect(ClaudeCodeProfiles.DUPLICATES.NotebookEdit).toBe("edit")
    expect(ClaudeCodeProfiles.ALIASES).toEqual({})
  })

  it("builds each profile's startup options", () => {
    const host = { static: ["BASE"], dynamic: ["ENV"] }
    const redsun = ClaudeCodeLanguageModel.interactiveOptions({ ...config, behavior: "redsun" }, host)
    expect(redsun.tools).toEqual([])
    expect(redsun.systemPrompt).toEqual(["BASE", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "ENV"])
    expect(redsun.planModeInstructions).toBeUndefined()
    expect(redsun.disallowedTools).toBeUndefined()
    // No host prompt (a live process), no systemPrompt option at all.
    expect(ClaudeCodeLanguageModel.interactiveOptions(config).systemPrompt).toBeUndefined()

    const extended = ClaudeCodeLanguageModel.interactiveOptions({ ...config, behavior: "extended" }, host)
    expect(extended.tools).toBeUndefined()
    expect(extended.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" })
    expect((extended.systemPrompt as { append?: string }).append).toContain("running inside redsun")
    expect(extended.disallowedTools).toEqual(Object.keys(ClaudeCodeProfiles.DUPLICATES))
    expect(extended.planModeInstructions).toContain("Plan Workflow")

    const native = ClaudeCodeLanguageModel.interactiveOptions({ ...config, behavior: "native" }, host)
    expect(native.systemPrompt).toEqual({ type: "preset", preset: "claude_code" })
    expect(native.disallowedTools).toBeUndefined()
    expect(native.tools).toBeUndefined()
  })

  it("resumes a cursor only under the profile that recorded it", () => {
    const stored = ClaudeCodeProfiles.record("cc_1", "redsun", "abc")
    expect(stored).toEqual({ cursor: "cc_1", profile: "redsun", promptHash: "abc" })
    expect(ClaudeCodeProfiles.parseCursor({ ...stored })).toEqual(stored)
    expect(ClaudeCodeProfiles.resumable(stored, "redsun")).toBe(true)
    expect(ClaudeCodeProfiles.resumable(stored, "extended")).toBe(false)
    // A changed prompt within one profile still resumes: the CLI keeps what it recorded.
    expect(ClaudeCodeProfiles.resumable({ ...stored, promptHash: "other" }, "redsun")).toBe(true)
  })

  it("reads a legacy plain-string cursor as recorded under an unknown profile", () => {
    const legacy = ClaudeCodeProfiles.parseCursor("cc_legacy")
    expect(legacy).toEqual({ cursor: "cc_legacy" })
    for (const profile of ["redsun", "extended", "native"] as const)
      expect(ClaudeCodeProfiles.resumable(legacy!, profile)).toBe(false)
    expect(ClaudeCodeProfiles.staleNotice(legacy!, "redsun").text).toContain("an earlier version of redsun")
    expect(ClaudeCodeProfiles.staleNotice(ClaudeCodeProfiles.record("cc", "native"), "redsun").text).toContain(
      'the "native" behavior profile',
    )
    expect(ClaudeCodeProfiles.parseCursor("")).toBeUndefined()
    expect(ClaudeCodeProfiles.parseCursor({ profile: "redsun" })).toBeUndefined()
    expect(ClaudeCodeProfiles.parseCursor({ cursor: "cc", profile: "bogus" })).toEqual({ cursor: "cc" })
  })

  it("hashes prompts stably", () => {
    const prompt = { static: ["a"], dynamic: ["b"] }
    expect(ClaudeCodeProfiles.promptHash(prompt)).toBe(ClaudeCodeProfiles.promptHash({ ...prompt }))
    expect(ClaudeCodeProfiles.promptHash(prompt)).not.toBe(ClaudeCodeProfiles.promptHash({ ...prompt, dynamic: [] }))
  })
})

describe("profile-aware modes and briefs", () => {
  it("never selects SDK plan or native auto under the redsun profile", () => {
    for (const global of ["normal", "auto", "native_auto"] as const) {
      expect(ClaudeCodeModes.permissionMode({ agentID: "plan", global, profile: "redsun" })).toBe("default")
      expect(ClaudeCodeModes.permissionMode({ agentID: "build", global, configured: "plan", profile: "redsun" })).toBe(
        "default",
      )
    }
    expect(ClaudeCodeModes.permissionMode({ agentID: "plan", profile: "extended" })).toBe("plan")
    expect(ClaudeCodeModes.permissionMode({ agentID: "build", global: "native_auto", profile: "native" })).toBe("auto")
  })

  it("drops the blocked built-in subagent sentence where there is no built-in subagent tool", () => {
    const brief = (profile?: ClaudeCodeProfiles.Name) =>
      ClaudeCodeTurnBrief.make({ agent: { id: "compose" }, isWorker: false, agentChanged: true, profile })
    expect(brief("redsun")).toContain("mcp__redsun__subagent")
    expect(brief("redsun")).not.toContain("built-in subagent tool")
    expect(brief("extended")).toContain("built-in subagent tool is blocked")
    expect(brief("native")).toContain("built-in subagent tool is blocked")
  })
})
