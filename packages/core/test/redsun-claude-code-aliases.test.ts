import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { ClaudeCodeProfiles } from "@redsun/runtime-claude-code/profiles"
import { EditTool } from "@opencode/core/tool/plugin/edit"
import { GlobTool } from "@opencode/core/tool/plugin/glob"
import { GrepTool } from "@opencode/core/tool/plugin/grep"
import { QuestionTool } from "@opencode/core/tool/plugin/question"
import { ReadTool } from "@opencode/core/tool/plugin/read"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { SkillTool } from "@opencode/core/tool/plugin/skill"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { WebFetchTool } from "@opencode/core/tool/plugin/webfetch"
import { WebSearchTool } from "@opencode/core/tool/plugin/websearch"
import { WriteTool } from "@opencode/core/tool/plugin/write"
import { RedsunTodo } from "@opencode/core/plugin/redsun/todo"

// The host inputs an alias may target: a model-emitted native call reaches these unchanged.
const HOST_INPUTS: Record<string, Schema.Top> = {
  [ShellTool.name]: ShellTool.Input,
  [ReadTool.name]: ReadTool.Input,
  [EditTool.name]: EditTool.Input,
  [WriteTool.name]: WriteTool.Input,
  [GlobTool.name]: GlobTool.Input,
  [GrepTool.name]: GrepTool.Input,
  [WebFetchTool.name]: WebFetchTool.Input,
  [WebSearchTool.name]: WebSearchTool.Input,
  [SubagentTool.name]: SubagentTool.Input,
  [SkillTool.name]: SkillTool.Input,
  [QuestionTool.name]: QuestionTool.Input,
}

// Representative native payloads, as Claude Code's own tool schemas shape them (CLI 2.1.282).
const NATIVE_PAYLOADS: Record<string, readonly Record<string, unknown>[]> = {
  Bash: [{ command: "ls" }, { command: "bun test", description: "Run tests", run_in_background: true }],
  Read: [{ file_path: "/repo/a.ts" }, { file_path: "/repo/a.ts", offset: 10, limit: 20 }],
  Edit: [{ file_path: "/repo/a.ts", old_string: "a", new_string: "b", replace_all: false }],
  Write: [{ file_path: "/repo/a.ts", content: "x" }],
  Glob: [{ pattern: "**/*.ts" }, { pattern: "*.ts", path: "/repo/src" }],
  Grep: [{ pattern: "TODO" }, { pattern: "TODO", glob: "*.ts", output_mode: "content", "-n": true }],
  WebFetch: [{ url: "https://example.com", prompt: "Summarize" }],
  WebSearch: [{ query: "redsun" }, { query: "redsun", allowed_domains: ["example.com"] }],
  Agent: [{ description: "Explore", prompt: "Find it", subagent_type: "general-purpose" }],
  Skill: [{ skill: "review" }],
  AskUserQuestion: [{ questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [] }] }],
}

/** Strict: a native argument the host would silently drop (e.g. run_in_background) is a failure. */
const accepts = (schema: Schema.Top, payload: Record<string, unknown>) => {
  try {
    Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>)(payload, { onExcessProperty: "error" })
    return true
  } catch {
    return false
  }
}

describe("Claude Code tool tables", () => {
  it("names a current host tool id for every duplicate", () => {
    const hostIDs = new Set([...Object.keys(HOST_INPUTS), RedsunTodo.NAME, "execute"])
    for (const [native, host] of Object.entries(ClaudeCodeProfiles.DUPLICATES)) {
      expect({ native, known: hostIDs.has(host) }).toEqual({ native, known: true })
    }
  })

  it("aliases only native names whose payloads the host schema accepts unchanged", () => {
    for (const [native, target] of Object.entries(ClaudeCodeProfiles.ALIASES)) {
      expect(target.startsWith(ClaudeCodeProfiles.HOST_PREFIX)).toBe(true)
      const host = target.slice(ClaudeCodeProfiles.HOST_PREFIX.length)
      expect(ClaudeCodeProfiles.DUPLICATES[native]).toBe(host)
      const schema = HOST_INPUTS[host]
      const payloads = NATIVE_PAYLOADS[native]
      // A new alias must add its host schema and native payload samples above.
      expect({ native, schema: !!schema, payloads: !!payloads?.length }).toEqual({
        native,
        schema: true,
        payloads: true,
      })
      for (const payload of payloads!)
        expect({ native, payload, accepted: accepts(schema!, payload) }).toMatchObject({
          accepted: true,
        })
    }
  })

  it("rejects the payloads a name-only redirect would break, which is why the table starts empty", () => {
    expect(accepts(ReadTool.Input, NATIVE_PAYLOADS.Read![0]!)).toBe(false)
    expect(accepts(EditTool.Input, NATIVE_PAYLOADS.Edit![0]!)).toBe(false)
    expect(accepts(ShellTool.Input, NATIVE_PAYLOADS.Bash![1]!)).toBe(false)
    expect(accepts(SubagentTool.Input, NATIVE_PAYLOADS.Agent![0]!)).toBe(false)
    // The harness is not rejecting everything.
    expect(accepts(ShellTool.Input, NATIVE_PAYLOADS.Bash![0]!)).toBe(true)
    expect(accepts(WebSearchTool.Input, NATIVE_PAYLOADS.WebSearch![0]!)).toBe(true)
  })
})
