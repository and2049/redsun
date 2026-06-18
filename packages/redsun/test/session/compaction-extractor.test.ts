import { describe, expect, test } from "bun:test"
import { CompactionExtractor } from "../../src/session/compaction-extractor"
import type { MessageV2 } from "../../src/session/message-v2"

function userMsg(id: string, text: string, time = Date.now()): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "s1",
      role: "user",
      time: { created: time },
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    },
    parts: [{ id: `p-${id}`, sessionID: "s1", messageID: id, type: "text", text }],
  }
}

function assistantMsg(id: string, text: string, time = Date.now()): MessageV2.WithParts {
  return {
    info: {
      id,
      sessionID: "s1",
      role: "assistant",
      time: { created: time },
      parentID: "parent",
      modelID: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: `p-${id}`, sessionID: "s1", messageID: id, type: "text", text }],
  }
}

function toolPart(
  id: string,
  tool: string,
  state: MessageV2.ToolPart["state"],
): MessageV2.ToolPart {
  return {
    id: `p-${id}`,
    sessionID: "s1",
    messageID: id,
    type: "tool",
    callID: `call-${id}`,
    tool,
    state,
  } as MessageV2.ToolPart
}

function patchPart(id: string, hash: string, files: string[]): MessageV2.PatchPart {
  return {
    id: `p-${id}`,
    sessionID: "s1",
    messageID: id,
    type: "patch",
    hash,
    files,
  } as MessageV2.PatchPart
}

describe("CompactionExtractor.createState", () => {
  test("creates empty working state", () => {
    const state = CompactionExtractor.createState()
    expect(state.task).toBe("")
    expect(state.userRequirements).toEqual([])
    expect(state.files.size).toBe(0)
    expect(state.toolResults).toEqual([])
    expect(state.failures).toEqual([])
    expect(state.assistantNotes).toEqual([])
    expect(state.todoState).toEqual([])
    expect(state.patches).toEqual([])
  })
})

describe("CompactionExtractor.extract — user messages", () => {
  test("first user message becomes task", () => {
    const state = CompactionExtractor.extract([userMsg("m1", "Fix the login bug")])
    expect(state.task).toBe("Fix the login bug")
    expect(state.userRequirements).toEqual([])
  })

  test("subsequent user messages become requirements", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Fix the login bug"),
      userMsg("m2", "Make sure to test the edge case"),
    ])
    expect(state.task).toBe("Fix the login bug")
    expect(state.userRequirements).toEqual(["Make sure to test the edge case"])
  })

  test("task is truncated to 400 chars", () => {
    const long = "x".repeat(600)
    const state = CompactionExtractor.extract([userMsg("m1", long)])
    expect(state.task.length).toBeLessThanOrEqual(400)
    expect(state.task.endsWith("...")).toBe(true)
  })

  test("compaction user messages are skipped", () => {
    const compactionMsg: MessageV2.WithParts = {
      info: {
        id: "m1",
        sessionID: "s1",
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude" },
      },
      parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "compaction", auto: true }],
    }
    const state = CompactionExtractor.extract([compactionMsg, userMsg("m2", "Real task")])
    expect(state.task).toBe("Real task")
  })
})

describe("CompactionExtractor.extract — tool calls", () => {
  test("read tool tracks file", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Read file"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "read", {
            status: "completed",
            input: { filePath: "/src/index.ts" },
            output: "export function main() {}\nexport class App {}",
            title: "read",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    expect(state.files.has("/src/index.ts")).toBe(true)
    const slot = state.files.get("/src/index.ts")!
    expect(slot.actions[0].type).toBe("read")
    expect(slot.actions[0]).toHaveProperty("summary")
    const summary = (slot.actions[0] as any).summary
    expect(summary).toContain("exports: main, App")
  })

  test("edit tool tracks file with old→new detail", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Edit file"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "edit", {
            status: "completed",
            input: { filePath: "/src/index.ts", oldString: "foo", newString: "bar" },
            output: "done",
            title: "edit",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    const slot = state.files.get("/src/index.ts")!
    expect(slot.actions[0].type).toBe("edit")
    expect((slot.actions[0] as any).detail).toContain('"foo"')
    expect((slot.actions[0] as any).detail).toContain('"bar"')
  })

  test("write tool tracks as create", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Write file"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "write", {
            status: "completed",
            input: { filePath: "/src/new.ts", content: "line1\nline2\nline3" },
            output: "done",
            title: "write",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    const slot = state.files.get("/src/new.ts")!
    expect(slot.actions[0].type).toBe("create")
    expect((slot.actions[0] as any).detail).toContain("3 lines")
  })

  test("bash tool records command", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Run command"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "bash", {
            status: "completed",
            input: { command: "npm test" },
            output: "All tests passed",
            title: "bash",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    expect(state.toolResults.length).toBe(1)
    expect(state.toolResults[0].tool).toBe("bash")
    expect(state.toolResults[0].summary).toContain("npm test")
    expect(state.toolResults[0].summary).toContain("All tests passed")
  })

  test("grep tool records match count", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Search"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "grep", {
            status: "completed",
            input: { pattern: "TODO" },
            output: "file1.ts:1:TODO fix\nfile2.ts:3:TODO refactor\nfile3.ts:5:TODO test",
            title: "grep",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    expect(state.toolResults.length).toBe(1)
    expect(state.toolResults[0].summary).toContain("3 matches")
  })
})

describe("CompactionExtractor.extract — errors", () => {
  test("error in tool output is captured as failure", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Run failing command"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "bash", {
            status: "completed",
            input: { command: "npm run build" },
            output: "Error: Cannot find module 'foo'\n    at line 1\nBUILD FAILED",
            title: "bash",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    expect(state.failures.length).toBe(1)
    expect(state.failures[0]).toContain("bash:")
  })

  test("tool state error is captured as failure", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Run failing command"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "bash", {
            status: "error",
            input: { command: "npm test" },
            error: "Command timed out after 30s",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    expect(state.failures.length).toBe(1)
    expect(state.failures[0]).toContain("Command timed out")
  })
})

describe("CompactionExtractor.extract — assistant notes", () => {
  test("short assistant text is skipped", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Hi"),
      assistantMsg("m2", "ok"),
    ])
    expect(state.assistantNotes).toEqual([])
  })

  test("filler sentences are filtered", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Do something"),
      assistantMsg("m2", "Let me check the file. I found the issue in the authentication module. The JWT token expiry was set too low. I'll increase it to 24 hours. This should resolve the login timeout problem."),
    ])
    expect(state.assistantNotes.length).toBe(1)
    expect(state.assistantNotes[0]).not.toContain("Let me check")
    expect(state.assistantNotes[0]).toContain("JWT token expiry")
  })

  test("≤3 sentences kept as single note", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Explain"),
      assistantMsg("m2", "The bug is in the auth module. JWT tokens expire too quickly. Increasing to 24h fixes it."),
    ])
    expect(state.assistantNotes.length).toBe(1)
    expect(state.assistantNotes[0]).toContain("JWT tokens expire")
  })
})

describe("CompactionExtractor.extract — patches", () => {
  test("patch parts are tracked", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Edit"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          patchPart("m2", "abc123", ["/src/index.ts", "/src/auth.ts"]),
        ],
      },
    ])
    expect(state.patches.length).toBe(1)
    expect(state.patches[0].files).toEqual(["/src/index.ts", "/src/auth.ts"])
  })
})

describe("CompactionExtractor.extract — TODO state", () => {
  test("todowrite captures todo state", () => {
    const todos = [
      { content: "Fix login", status: "completed", priority: "high", id: "t1" },
      { content: "Write tests", status: "in_progress", priority: "medium", id: "t2" },
      { content: "Update docs", status: "pending", priority: "low", id: "t3" },
    ]
    const state = CompactionExtractor.extract([
      userMsg("m1", "Work on todos"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "todowrite", {
            status: "completed",
            input: { todos },
            output: JSON.stringify(todos),
            title: "3 todos",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    expect(state.todoState.length).toBe(3)
    expect(state.todoState[0].content).toBe("Fix login")
  })
})

describe("CompactionExtractor.serialize", () => {
  test("empty state produces empty string", () => {
    expect(CompactionExtractor.serialize(CompactionExtractor.createState())).toBe("")
  })

  test("renders all non-empty sections", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Fix login bug"),
      userMsg("m2", "Also add tests"),
      {
        ...assistantMsg("m3", "I found the issue. The JWT token expiry was set to 5 minutes instead of 24 hours. I will update the configuration to use a longer expiry period."),
        parts: [
          { id: "p-m3-text", sessionID: "s1", messageID: "m3", type: "text", text: "I found the issue. The JWT token expiry was set to 5 minutes instead of 24 hours. I will update the configuration to use a longer expiry period." },
          toolPart("m3", "edit", {
            status: "completed",
            input: { filePath: "/src/auth.ts", oldString: "maxAge: 300", newString: "maxAge: 86400" },
            output: "done",
            title: "edit",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
          patchPart("m3", "abc", ["/src/auth.ts"]),
        ],
      },
    ])
    const result = CompactionExtractor.serialize(state)
    expect(result).toContain("## Task")
    expect(result).toContain("Fix login bug")
    expect(result).toContain("## User Requirements")
    expect(result).toContain("Also add tests")
    expect(result).toContain("## Files Touched")
    expect(result).toContain("/src/auth.ts")
    expect(result).toContain("## Assistant Notes")
    expect(result).toContain("JWT token expiry")
    expect(result).toContain("## File Changes")
  })

  test("task-only state renders just task section", () => {
    const state = CompactionExtractor.extract([userMsg("m1", "Hello world")])
    const result = CompactionExtractor.serialize(state)
    expect(result).toBe("## Task\n\nHello world")
  })
})

describe("CompactionExtractor.slotCount", () => {
  test("counts all populated slots", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Task"),
      userMsg("m2", "Requirement 1"),
      {
        ...assistantMsg("m3", "Working on it now. The issue is in the auth module. JWT tokens are expiring too fast. I need to increase the timeout value to something more reasonable."),
        parts: [
          { id: "p-m3-text", sessionID: "s1", messageID: "m3", type: "text", text: "Working on it now. The issue is in the auth module. JWT tokens are expiring too fast. I need to increase the timeout value to something more reasonable." },
          toolPart("m3", "read", {
            status: "completed",
            input: { filePath: "/src/auth.ts" },
            output: "export function auth() {}",
            title: "read",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    const count = CompactionExtractor.slotCount(state)
    expect(count).toBeGreaterThan(0)
    expect(count).toBe(1 + 1 + 1 + 1)
  })

  test("empty state has slot count 0", () => {
    expect(CompactionExtractor.slotCount(CompactionExtractor.createState())).toBe(0)
  })
})

describe("CompactionExtractor.extractRecentMessages", () => {
  test("returns all messages when fewer than keepRecent", () => {
    const msgs = [userMsg("m1", "hello")]
    const result = CompactionExtractor.extractRecentMessages(msgs, 4)
    expect(result.length).toBe(1)
  })

  test("slices last N messages", () => {
    const msgs = [
      userMsg("m1", "1"),
      assistantMsg("m2", "2"),
      userMsg("m3", "3"),
      assistantMsg("m4", "4"),
      userMsg("m5", "5"),
      assistantMsg("m6", "6"),
    ]
    const result = CompactionExtractor.extractRecentMessages(msgs, 4)
    expect(result.length).toBe(4)
    expect(result[0].info.id).toBe("m3")
  })
})

describe("CompactionExtractor.extract — summary assistant skipped", () => {
  test("summary assistant messages are not processed", () => {
    const summaryMsg: MessageV2.WithParts = {
      info: {
        id: "m1",
        sessionID: "s1",
        role: "assistant",
        time: { created: Date.now() },
        parentID: "parent",
        modelID: "claude",
        providerID: "anthropic",
        mode: "compaction",
        agent: "compaction",
        summary: true,
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "Previous summary text" }],
    }
    const state = CompactionExtractor.extract([summaryMsg, userMsg("m2", "New task")])
    expect(state.task).toBe("New task")
    expect(state.assistantNotes).toEqual([])
  })
})

describe("CompactionExtractor.extractRecentMessages — edge cases", () => {
  test("backs up past assistant with tool calls", () => {
    const msgs = [
      userMsg("m1", "1"),
      assistantMsg("m2", "2"),
      userMsg("m3", "3"),
      {
        ...assistantMsg("m4", ""),
        parts: [
          toolPart("m4", "edit", {
            status: "completed",
            input: { filePath: "/a.ts", oldString: "x", newString: "y" },
            output: "done",
            title: "edit",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
      userMsg("m5", "5"),
    ]
    const result = CompactionExtractor.extractRecentMessages(msgs, 2)
    expect(result.length).toBe(3)
    expect(result[0].info.id).toBe("m3")
  })

  test("does not crash when all messages are assistant with tools", () => {
    const msgs = [
      userMsg("m1", "1"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "edit", {
            status: "completed",
            input: { filePath: "/a.ts", oldString: "x", newString: "y" },
            output: "done",
            title: "edit",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
      {
        ...assistantMsg("m3", ""),
        parts: [
          toolPart("m3", "edit", {
            status: "completed",
            input: { filePath: "/b.ts", oldString: "x", newString: "y" },
            output: "done",
            title: "edit",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ]
    const result = CompactionExtractor.extractRecentMessages(msgs, 1)
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  test("keepRecent=0 returns empty or minimal slice", () => {
    const msgs = [userMsg("m1", "1"), assistantMsg("m2", "2"), userMsg("m3", "3")]
    const result = CompactionExtractor.extractRecentMessages(msgs, 0)
    expect(result.length).toBe(0)
  })
})

describe("CompactionExtractor.extract — error false positives", () => {
  test("grep results containing 'error' text are not flagged as failures", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Search for errors"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "grep", {
            status: "completed",
            input: { pattern: "Error" },
            output: "auth.ts:5:throw new Error('invalid')\nauth.ts:10:console.error('failed')",
            title: "grep",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    expect(state.failures.length).toBe(0)
  })

  test("read results containing 'error' text are not flagged as failures", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Read file"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "read", {
            status: "completed",
            input: { filePath: "/src/auth.ts" },
            output: "function login() {\n  throw new Error('invalid credentials')\n}",
            title: "read",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    expect(state.failures.length).toBe(0)
  })

  test("bash results containing 'error' are flagged as failures", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Run build"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "bash", {
            status: "completed",
            input: { command: "npm run build" },
            output: "Error: Cannot find module 'foo'",
            title: "bash",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    expect(state.failures.length).toBe(1)
  })
})

describe("CompactionExtractor.extract — multiedit detail", () => {
  test("multiedit captures edit count and first edit", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Edit"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "multiedit", {
            status: "completed",
            input: {
              filePath: "/src/index.ts",
              edits: [
                { oldString: "foo", newString: "bar" },
                { oldString: "baz", newString: "qux" },
              ],
            },
            output: "done",
            title: "multiedit",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    const slot = state.files.get("/src/index.ts")!
    expect(slot.actions[0].type).toBe("edit")
    const detail = (slot.actions[0] as any).detail
    expect(detail).toContain("2 edits")
    expect(detail).toContain('"foo"')
    expect(detail).toContain('"bar"')
  })
})

describe("CompactionExtractor.extract — task result captured", () => {
  test("task tool result is captured in toolResults", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Dispatch subagent"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "task", {
            status: "completed",
            input: { description: "Find all tests" },
            output: "Found 15 test files in the project. Most use bun:test.",
            title: "task",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    const taskResults = state.toolResults.filter((r) => r.tool === "task")
    expect(taskResults.length).toBeGreaterThanOrEqual(1)
    expect(taskResults.some((r) => r.summary.includes("Found 15 test files"))).toBe(true)
  })
})

describe("CompactionExtractor.extract — maxToolResults", () => {
  test("caps serialized tool result inventory", () => {
    const state = CompactionExtractor.extract(
      [
        {
          ...assistantMsg("m1", "Collected tool results"),
          parts: [
            toolPart("m1-bash", "bash", {
              status: "completed",
              input: { command: "bun test" },
              output: "ok",
              title: "bash",
              metadata: {},
              time: { start: 0, end: 1 },
            }),
            toolPart("m1-grep", "grep", {
              status: "completed",
              input: { pattern: "TODO" },
              output: "a\nb\nc",
              title: "grep",
              metadata: {},
              time: { start: 0, end: 1 },
            }),
            toolPart("m1-web", "webfetch", {
              status: "completed",
              input: { url: "https://example.com" },
              output: "example output",
              title: "webfetch",
              metadata: {},
              time: { start: 0, end: 1 },
            }),
            toolPart("m1-task", "task", {
              status: "completed",
              input: { description: "Subtask" },
              output: "subtask output",
              title: "task",
              metadata: {},
              time: { start: 0, end: 1 },
            }),
          ],
        },
      ],
      { maxToolResults: 2 },
    )

    expect(state.toolResults.map((item) => item.tool)).toEqual(["webfetch", "task"])
    expect(CompactionExtractor.serialize(state)).toContain("## Tool Results")
  })
})

describe("CompactionExtractor.serialize — cancelled TODO", () => {
  test("cancelled status renders with ~ marker", () => {
    const state = CompactionExtractor.createState()
    state.todoState = [
      { content: "Done task", status: "completed", priority: "high", id: "t1" },
      { content: "Cancelled task", status: "cancelled", priority: "low", id: "t2" },
    ]
    const result = CompactionExtractor.serialize(state)
    expect(result).toContain("[x]")
    expect(result).toContain("[~]")
    expect(result).toContain("Cancelled task")
  })
})

describe("CompactionExtractor.extract — project tool", () => {
  test("project tool captures action field", () => {
    const state = CompactionExtractor.extract([
      userMsg("m1", "Run project check"),
      {
        ...assistantMsg("m2", ""),
        parts: [
          toolPart("m2", "project", {
            status: "completed",
            input: { action: "check", file: "src/" },
            output: "typecheck: pass\nlint: pass\ntest: 5 passed",
            title: "project",
            metadata: {},
            time: { start: 0, end: 1 },
          }),
        ],
      },
    ])
    expect(state.toolResults.length).toBe(1)
    expect(state.toolResults[0].tool).toBe("project")
    expect(state.toolResults[0].summary).toContain("check")
    expect(state.toolResults[0].summary).toContain("src/")
  })
})
