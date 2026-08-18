import { describe, expect, it } from "bun:test"
import { ClaudeCodeNativeTools } from "@opencode-ai/core/plugin/redsun/claude-code/native-tools"

const { toolName, toolInput, resultMetadata, SUBAGENT_TOOLS } = ClaudeCodeNativeTools

describe("tool name mapping", () => {
  it("renames the built-ins v2 already knows", () => {
    expect(toolName("Bash")).toBe("shell")
    expect(toolName("Read")).toBe("read")
    expect(toolName("Glob")).toBe("glob")
    expect(toolName("Grep")).toBe("grep")
    expect(toolName("Edit")).toBe("edit")
    expect(toolName("Write")).toBe("write")
    expect(toolName("Skill")).toBe("skill")
  })

  it("leaves an unlisted tool on its raw name and the generic renderer", () => {
    expect(toolName("BashOutput")).toBe("BashOutput")
    expect(toolName("mcp__redsun__subagent")).toBe("mcp__redsun__subagent")
  })

  it("knows both spellings of the subagent tool", () => {
    expect(SUBAGENT_TOOLS.has("Task")).toBe(true)
    expect(SUBAGENT_TOOLS.has("Agent")).toBe(true)
  })
})

describe("tool input mapping", () => {
  it("renames file paths onto the key the renderers read", () => {
    // Every path-shaped renderer resolves `input.path`, so a `file_path` that
    // survives leaves the row with no file on it.
    expect(toolInput("Read", { file_path: "/a.ts", offset: 2 })).toEqual({ path: "/a.ts", offset: 2 })
    expect(toolInput("Write", { file_path: "/a.ts", content: "x" })).toEqual({ path: "/a.ts", content: "x" })
    expect(toolInput("Edit", { file_path: "/a.ts", old_string: "a", new_string: "b", replace_all: true })).toEqual({
      path: "/a.ts",
      oldString: "a",
      newString: "b",
      replaceAll: true,
    })
  })

  it("maps grep's glob onto include and skill's name onto id", () => {
    expect(toolInput("Grep", { pattern: "x", glob: "*.ts" })).toEqual({ pattern: "x", include: "*.ts" })
    // The skill row falls back to `input.id` when the result carries no name.
    expect(toolInput("Skill", { skill: "artifact-design" })).toEqual({ id: "artifact-design" })
  })

  it("passes an unlisted tool's input through untouched", () => {
    const input = { file_path: "/a.ts" }
    expect(toolInput("NotebookEdit", input)).toBe(input)
  })
})

describe("result metadata", () => {
  const editResult = {
    filePath: "/a.ts",
    oldString: "const a = 1",
    newString: "const a = 2",
    originalFile: "const a = 1\nconst b = 2\n",
    replaceAll: false,
  }

  it("re-derives an edit diff in the shape the renderers require", () => {
    const metadata = resultMetadata("edit", { path: "/a.ts" }, editResult)
    const file = metadata?.files[0]
    // `parseApplyPatchFiles` drops a file missing any of these, and the diff
    // block only renders for a file it kept.
    expect(file).toMatchObject({ file: "/a.ts", status: "modified", additions: 1, deletions: 1 })
    expect(file?.patch).toContain("-const a = 1")
    expect(file?.patch).toContain("+const a = 2")
  })

  it("replaces every occurrence when the edit did", () => {
    const original = "x\nx\n"
    const one = resultMetadata("edit", { path: "/a.ts" }, { ...editResult, originalFile: original, oldString: "x", newString: "y", replaceAll: false })
    const all = resultMetadata("edit", { path: "/a.ts" }, { ...editResult, originalFile: original, oldString: "x", newString: "y", replaceAll: true })
    expect(one?.files[0]?.additions).toBe(1)
    expect(all?.files[0]?.additions).toBe(2)
  })

  it("treats a replacement's dollar patterns as literal text", () => {
    // `String.replace` with a string pattern expands `$&` in the replacement,
    // which would silently write different text into the rendered diff than the
    // CLI actually wrote to disk.
    const metadata = resultMetadata(
      "edit",
      { path: "/a.ts" },
      { ...editResult, originalFile: "cost\n", oldString: "cost", newString: "$& $1 $$" },
    )
    expect(metadata?.files[0]?.patch).toContain("+$& $1 $$")
  })

  it("diffs a write against the file it replaced", () => {
    const metadata = resultMetadata(
      "write",
      { path: "/a.ts" },
      { type: "update", filePath: "/a.ts", content: "next\n", originalFile: "prev\n" },
    )
    expect(metadata?.files[0]).toMatchObject({ file: "/a.ts", status: "modified", additions: 1, deletions: 1 })
  })

  it("marks a created file as added", () => {
    const metadata = resultMetadata(
      "write",
      { path: "/new.ts" },
      { type: "create", filePath: "/new.ts", content: "hello\n", originalFile: null },
    )
    expect(metadata?.files[0]).toMatchObject({ file: "/new.ts", status: "added", additions: 1, deletions: 0 })
  })

  it("refuses a result whose path is not this call's path", () => {
    // `tool_use_result` is message-level while tool results are blocks, so a
    // mismatch must yield nothing rather than attach a diff to the wrong call.
    expect(resultMetadata("edit", { path: "/other.ts" }, editResult)).toBeUndefined()
  })

  it("yields nothing for a tool with no native diff, or an unusable result", () => {
    expect(resultMetadata("shell", { command: "ls" }, { stdout: "a" })).toBeUndefined()
    expect(resultMetadata("read", { path: "/a.ts" }, { content: "a" })).toBeUndefined()
    expect(resultMetadata("edit", { path: "/a.ts" }, undefined)).toBeUndefined()
    expect(resultMetadata("edit", {}, editResult)).toBeUndefined()
    // No pre-edit content means no diff can be re-derived.
    expect(resultMetadata("edit", { path: "/a.ts" }, { ...editResult, originalFile: null })).toBeUndefined()
    // A no-op edit has nothing to show.
    expect(
      resultMetadata("edit", { path: "/a.ts" }, { ...editResult, oldString: "absent", newString: "x" }),
    ).toBeUndefined()
  })
})
