import { describe, expect, it } from "bun:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeLanguageModel } from "@opencode-ai/core/plugin/redsun/claude-code/language-model"
import { ClaudeCodePermissions } from "@opencode-ai/core/plugin/redsun/claude-code/permissions"
import { ClaudeCodeQuery } from "@opencode-ai/core/plugin/redsun/claude-code/query"
import { ClaudeCodeSessions } from "@opencode-ai/core/plugin/redsun/claude-code/sessions"

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] })

const iterable = (messages: readonly unknown[]): AsyncIterable<SDKMessage> => ({
  async *[Symbol.asyncIterator]() {
    for (const message of messages) yield message as SDKMessage
  },
})

/** Records what the manager was asked to run and replays a fixture stream. */
const fakeManager = (messages: readonly unknown[]) => {
  const calls: { sessionID: string; prompt: unknown; options: any }[] = []
  const manager = {
    turn: async (sessionID: string, prompt: unknown, options: any) => {
      calls.push({ sessionID, prompt, options })
      return iterable(messages)
    },
  } as unknown as ClaudeCodeSessions.SessionManager
  return { manager, calls }
}

const collect = async (stream: ReadableStream<LanguageModelV3StreamPart>) => {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

const call = (input: Partial<LanguageModelV3CallOptions>): LanguageModelV3CallOptions =>
  ({ prompt: [], headers: { "x-opencode-session": "ses_1" }, ...input }) as LanguageModelV3CallOptions

const config = { executablePath: "/usr/bin/claude", cwd: "/repo" }

describe("ClaudeCodeLanguageModel.promptDelta", () => {
  it("sends only what Claude Code has not seen since the last assistant turn", () => {
    expect(
      ClaudeCodeLanguageModel.promptDelta([user("first"), assistant("reply"), user("second"), user("third")]),
    ).toBe("second\n\nthird")
  })

  it("sends the whole first turn when there is no assistant message yet", () => {
    expect(ClaudeCodeLanguageModel.promptDelta([user("only")])).toBe("only")
  })

  it("falls back to the last user message when nothing follows the assistant", () => {
    expect(ClaudeCodeLanguageModel.promptDelta([user("earlier"), assistant("reply")])).toBe("earlier")
  })
})

describe("ClaudeCodeLanguageModel.sessionIDFrom", () => {
  it("reads the session header case-insensitively", () => {
    expect(ClaudeCodeLanguageModel.sessionIDFrom({ "X-OpenCode-Session": "ses_9" })).toBe("ses_9")
    expect(ClaudeCodeLanguageModel.sessionIDFrom({})).toBeUndefined()
    expect(ClaudeCodeLanguageModel.sessionIDFrom(undefined)).toBeUndefined()
  })
})

describe("ClaudeCodeLanguageModel.doStream", () => {
  const model = (input: Parameters<typeof ClaudeCodeLanguageModel.make>[0]) => ClaudeCodeLanguageModel.make(input)

  it("streams a turn through the session manager keyed on the session header", async () => {
    const { manager, calls } = fakeManager([
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
      { type: "result", subtype: "success", usage: {} },
    ])
    const created = model({ modelID: "sonnet", config, manager, createQuery: () => ({}) as never })
    const { stream } = await created.doStream(call({ prompt: [user("hello")] }))
    const parts = await collect(stream)

    expect(calls[0]!.sessionID).toBe("ses_1")
    expect(calls[0]!.prompt).toEqual([{ type: "text", text: "hello" }])
    expect(parts.map((part) => part.type)).toEqual(["stream-start", "text-start", "text-delta", "finish"])
  })

  it("errors instead of guessing when the request carries no session", async () => {
    const { manager } = fakeManager([])
    const created = model({ modelID: "sonnet", config, manager, createQuery: () => ({}) as never })
    const { stream } = await created.doStream(call({ prompt: [user("hi")], headers: {} }))
    const parts = await collect(stream)
    expect(parts.at(-1)).toMatchObject({ type: "error" })
  })

  it("passes the resume cursor and records the one Claude Code reports back", async () => {
    const { manager, calls } = fakeManager([
      { type: "system", subtype: "init", session_id: "cc_new" },
      { type: "result", subtype: "success", usage: {} },
    ])
    const recorded: Record<string, string> = {}
    const created = model({
      modelID: "opus",
      config,
      manager,
      createQuery: () => ({}) as never,
      hooks: {
        resumeCursor: () => "cc_old",
        onCursor: (sessionID, claudeSessionID) => void (recorded[sessionID] = claudeSessionID),
      },
    })
    await collect((await created.doStream(call({ prompt: [user("go")] }))).stream)

    expect(calls[0]!.options.options.resume).toBe("cc_old")
    expect(recorded).toEqual({ ses_1: "cc_new" })
  })

  it("routes an internal one-shot away from the interactive process", async () => {
    const { manager, calls } = fakeManager([])
    const oneShot: any[] = []
    const created = model({
      modelID: "haiku",
      config,
      manager,
      createQuery: (input) => {
        oneShot.push(input)
        return iterable([{ type: "result", subtype: "success", usage: {} }]) as never
      },
      hooks: { isOneShot: () => true },
    })
    await collect((await created.doStream(call({ prompt: [user("summarize this")] }))).stream)

    expect(calls).toHaveLength(0)
    expect(oneShot[0].options).toMatchObject({ maxTurns: 1, allowedTools: [], persistSession: false })
    // A one-shot flattens the transcript rather than sending only a delta.
    expect(oneShot[0].prompt).toContain("user: summarize this")
  })

  it("refuses a turn with nothing new to say", async () => {
    const { manager } = fakeManager([])
    const created = model({ modelID: "sonnet", config, manager, createQuery: () => ({}) as never })
    const { stream } = await created.doStream(call({ prompt: [] }))
    expect(await collect(stream)).toMatchObject([{ type: "stream-start" }, { type: "error" }])
  })

  it("always targets the resolved CLI, never the SDK's bundled one", () => {
    expect(() =>
      ClaudeCodeQuery.defaultCreateQuery({ prompt: "hi", options: {} as never }),
    ).toThrow(/refusing to spawn the SDK's bundled CLI/)
  })
})

describe("ClaudeCodePermissions", () => {
  const worktree = "/repo"

  it("asks with worktree-relative patterns so user path rules match", () => {
    expect(
      ClaudeCodePermissions.mapPermission({ toolName: "Edit", input: { file_path: "/repo/src/a.ts" }, worktree }),
    ).toEqual({ action: "edit", resource: "src/a.ts" })
    expect(
      ClaudeCodePermissions.mapPermission({ toolName: "Read", input: { file_path: "/repo/b.ts" }, worktree }),
    ).toEqual({ action: "read", resource: "b.ts" })
  })

  it("maps Claude's tools onto v2 permission actions", () => {
    expect(ClaudeCodePermissions.mapPermission({ toolName: "Bash", input: { command: "ls -al" }, worktree })).toEqual({
      action: "shell",
      resource: "ls -al",
    })
    expect(
      ClaudeCodePermissions.mapPermission({ toolName: "Agent", input: { subagent_type: "worker" }, worktree }),
    ).toEqual({ action: "subagent", resource: "worker" })
    expect(ClaudeCodePermissions.mapPermission({ toolName: "AskUserQuestion", input: {}, worktree })).toEqual({
      action: "question",
      resource: "*",
    })
  })

  it("gives unknown tools their own action rather than widening a real one", () => {
    expect(
      ClaudeCodePermissions.mapPermission({ toolName: "mcp__weird__thing", input: {}, worktree }),
    ).toEqual({ action: "claude_code", resource: "mcp__weird__thing" })
  })

  it("flags a file outside the worktree as an external directory", () => {
    expect(
      ClaudeCodePermissions.externalDirectory({ toolName: "Read", input: { file_path: "/etc/passwd" }, worktree }),
    ).toBe("/etc/*")
    expect(
      ClaudeCodePermissions.externalDirectory({ toolName: "Read", input: { file_path: "/repo/in.ts" }, worktree }),
    ).toBeUndefined()
  })

  it("treats search and todo tools as read-only", () => {
    expect(ClaudeCodePermissions.isReadOnly("Grep")).toBe(true)
    expect(ClaudeCodePermissions.isReadOnly("Bash")).toBe(false)
  })
})
