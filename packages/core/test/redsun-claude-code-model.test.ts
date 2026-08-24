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
  const interrupted: string[] = []
  const manager = {
    turn: async (sessionID: string, prompt: unknown, options: any) => {
      calls.push({ sessionID, prompt, options })
      return iterable(messages)
    },
    interrupt: async (sessionID: string) => void interrupted.push(sessionID),
  } as unknown as ClaudeCodeSessions.SessionManager
  return { manager, calls, interrupted }
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
  const text = (prompt: Parameters<typeof ClaudeCodeLanguageModel.promptDelta>[0]) =>
    ClaudeCodeLanguageModel.promptDelta(prompt).text

  it("sends only what Claude Code has not seen since the last assistant turn", () => {
    expect(text([user("first"), assistant("reply"), user("second"), user("third")])).toBe("second\n\nthird")
  })

  it("sends the whole first turn when there is no assistant message yet", () => {
    expect(text([user("only")])).toBe("only")
  })

  it("falls back to the last user message when nothing follows the assistant", () => {
    expect(text([user("earlier"), assistant("reply")])).toBe("earlier")
  })

  it("carries attachments through, which the text-only delta dropped silently", () => {
    const png = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "what is this" },
        { type: "file" as const, mediaType: "image/png", data: "AAAA", filename: "shot.png" },
      ],
    }
    expect(ClaudeCodeLanguageModel.promptDelta([png])).toEqual({
      text: "what is this",
      blocks: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
    })
  })

  it("sends a PDF as a document and anything else as a placeholder", () => {
    const file = (mediaType: string) => ({
      role: "user" as const,
      content: [{ type: "file" as const, mediaType, data: "AAAA", filename: "f" }],
    })
    expect(ClaudeCodeLanguageModel.promptDelta([file("application/pdf")]).blocks).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" }, title: "f" },
    ])
    // The CLI rejects an image media_type outside Anthropic's union, so an
    // unsupported type degrades to text rather than failing the turn.
    expect(ClaudeCodeLanguageModel.promptDelta([file("image/tiff")]).blocks).toEqual([
      { type: "text", text: "[Attached image/tiff: f]" },
    ])
  })

  it("encodes binary attachment data", () => {
    const bytes = new Uint8Array([1, 2, 3])
    const message = {
      role: "user" as const,
      content: [{ type: "file" as const, mediaType: "image/png", data: bytes }],
    }
    expect(ClaudeCodeLanguageModel.promptDelta([message]).blocks).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: Buffer.from(bytes).toString("base64") },
      },
    ])
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

  it("reports a silent CLI model substitution from main-thread assistant frames", async () => {
    const { manager, calls } = fakeManager([{ type: "result", subtype: "success", usage: {} }])
    const seen: unknown[] = []
    const created = model({
      modelID: "claude-opus-4-1",
      config,
      manager,
      createQuery: () => ({}) as never,
      hooks: { onModelSubstituted: (sessionID, input) => seen.push([sessionID, input]) },
    })
    const { stream } = await created.doStream(call({ prompt: [user("hello")] }))
    await collect(stream)

    const observer = calls[0]!.options.observer as (message: unknown, inTurn: boolean) => Promise<void> | void
    // A subagent frame may legitimately run another model; a dated snapshot of
    // the requested pin is the requested model. Only the substitution reports.
    await observer({ type: "assistant", parent_tool_use_id: "toolu_1", message: { model: "claude-haiku-4-5" } }, true)
    await observer({ type: "assistant", parent_tool_use_id: null, message: { model: "claude-opus-4-1-20250805" } }, true)
    await observer({ type: "assistant", parent_tool_use_id: null, message: { model: "claude-opus-5" } }, true)

    expect(seen).toEqual([["ses_1", { requested: "claude-opus-4-1", served: "claude-opus-5" }]])
  })

  it("never reports a substitution for an alias, which resolves by design", async () => {
    const { manager, calls } = fakeManager([{ type: "result", subtype: "success", usage: {} }])
    const seen: unknown[] = []
    const created = model({
      modelID: "opus",
      config,
      manager,
      createQuery: () => ({}) as never,
      hooks: { onModelSubstituted: (sessionID, input) => seen.push([sessionID, input]) },
    })
    const { stream } = await created.doStream(call({ prompt: [user("hello")] }))
    await collect(stream)

    const observer = calls[0]!.options.observer as (message: unknown, inTurn: boolean) => Promise<void> | void
    await observer({ type: "assistant", parent_tool_use_id: null, message: { model: "claude-opus-5" } }, true)

    expect(seen).toEqual([])
  })

  it("prepends the turn brief, which is the only way an agent's instructions arrive", async () => {
    // A delegated turn sends no system prompt, so `agent.system` never reaches
    // the CLI. See turn-brief.ts.
    const { manager, calls } = fakeManager([{ type: "result", subtype: "success", usage: {} }])
    const created = model({
      modelID: "sonnet",
      config,
      manager,
      createQuery: () => ({}) as never,
      hooks: { turnBrief: () => "[redsun compose mode] delegate" },
    })
    await collect((await created.doStream(call({ prompt: [user("build it")] }))).stream)
    expect(calls[0]!.prompt).toEqual([{ type: "text", text: "[redsun compose mode] delegate\n\nbuild it" }])
  })

  it("sends the prompt unchanged when there is no brief", async () => {
    const { manager, calls } = fakeManager([{ type: "result", subtype: "success", usage: {} }])
    const created = model({
      modelID: "sonnet",
      config,
      manager,
      createQuery: () => ({}) as never,
      hooks: { turnBrief: () => undefined },
    })
    await collect((await created.doStream(call({ prompt: [user("build it")] }))).stream)
    expect(calls[0]!.prompt).toEqual([{ type: "text", text: "build it" }])
  })

  it("sends the CLI's own system prompt and settings for an interactive turn", async () => {
    // Without the preset the SDK sends no Claude Code system prompt at all, and
    // without settingSources the CLI reads neither CLAUDE.md nor user settings.
    const { manager, calls } = fakeManager([{ type: "result", subtype: "success", usage: {} }])
    const created = model({ modelID: "sonnet", config, manager, createQuery: () => ({}) as never })
    await collect((await created.doStream(call({ prompt: [user("hi")] }))).stream)
    expect(calls[0]!.options.options).toMatchObject({
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
    })
    expect(calls[0]!.options.options.planModeInstructions).toContain("Plan Workflow")
  })

  it("treats a request marked internal as one-shot without being told", async () => {
    // Title generation has its own path and never fires the session context
    // hook, so before the header it ran through the live CLI process --
    // delivering "generate a title" into the user's Claude Code conversation.
    const { manager, calls } = fakeManager([])
    const oneShot: any[] = []
    const created = model({
      modelID: "sonnet",
      config,
      manager,
      createQuery: (input: any) => {
        oneShot.push(input)
        return iterable([{ type: "result", subtype: "success", usage: {} }]) as never
      },
    })
    await collect(
      (
        await created.doStream(
          call({
            prompt: [user("name this")],
            headers: { "x-opencode-session": "ses_1", "x-opencode-internal": "1" },
          }),
        )
      ).stream,
    )
    expect(calls).toHaveLength(0)
    expect(oneShot[0].options).toMatchObject({ maxTurns: 1, allowedTools: [], persistSession: false })
    // Not a coding turn, so no preset and no project settings.
    expect(oneShot[0].options.systemPrompt).toBeUndefined()
    expect(oneShot[0].options.settingSources).toBeUndefined()
  })

  it("interrupts the CLI when the turn is aborted", async () => {
    // Tearing down this stream only ends redsun's view of the turn. Without the
    // control request the Claude Code process keeps running its loop, editing
    // files for a turn the user already stopped.
    const { manager, interrupted } = fakeManager([{ type: "result", subtype: "success", usage: {} }])
    const created = model({ modelID: "sonnet", config, manager, createQuery: () => ({}) as never })
    const control = new AbortController()
    const { stream } = await created.doStream(call({ prompt: [user("go")], abortSignal: control.signal }))
    await collect(stream)
    expect(interrupted).toEqual([])
    control.abort()
    // The listener is detached once the turn finishes on its own, so a later
    // abort does not interrupt whatever turn is running by then.
    expect(interrupted).toEqual([])
  })

  it("interrupts a turn that is still running", async () => {
    const { manager, interrupted } = fakeManager([])
    // A turn that never produces its `result`, i.e. one still working.
    ;(manager as any).turn = async () => ({
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
    })
    const created = model({ modelID: "sonnet", config, manager, createQuery: () => ({}) as never })
    const control = new AbortController()
    await created.doStream(call({ prompt: [user("go")], abortSignal: control.signal }))
    control.abort()
    expect(interrupted).toEqual(["ses_1"])
  })

  it("interrupts immediately when the signal was already aborted", async () => {
    const { manager, interrupted } = fakeManager([{ type: "result", subtype: "success", usage: {} }])
    const created = model({ modelID: "sonnet", config, manager, createQuery: () => ({}) as never })
    await created.doStream(call({ prompt: [user("go")], abortSignal: AbortSignal.abort() }))
    expect(interrupted).toEqual(["ses_1"])
  })

  it("interrupts when the reader is cancelled", async () => {
    const { manager, interrupted } = fakeManager([{ type: "result", subtype: "success", usage: {} }])
    const created = model({ modelID: "sonnet", config, manager, createQuery: () => ({}) as never })
    const { stream } = await created.doStream(call({ prompt: [user("go")] }))
    await stream.cancel()
    expect(interrupted).toEqual(["ses_1"])
  })

  it("passes extra args that carry a value", async () => {
    const { manager, calls } = fakeManager([{ type: "result", subtype: "success", usage: {} }])
    const created = model({
      modelID: "sonnet",
      // The list form cannot say `--mcp-config path`; V1's record form can.
      config: { ...config, extraArgs: { "--mcp-config": "/tmp/mcp.json", "--verbose": null } },
      manager,
      createQuery: () => ({}) as never,
    })
    await collect((await created.doStream(call({ prompt: [user("go")] }))).stream)
    expect(calls[0]!.options.options.extraArgs).toEqual({ "--mcp-config": "/tmp/mcp.json", "--verbose": null })
  })

  it("still accepts a plain list of flags", async () => {
    const { manager, calls } = fakeManager([{ type: "result", subtype: "success", usage: {} }])
    const created = model({
      modelID: "sonnet",
      config: { ...config, extraArgs: ["--verbose"] },
      manager,
      createQuery: () => ({}) as never,
    })
    await collect((await created.doStream(call({ prompt: [user("go")] }))).stream)
    expect(calls[0]!.options.options.extraArgs).toEqual({ "--verbose": null })
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
