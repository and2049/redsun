import { describe, expect, it } from "bun:test"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeExecutable } from "../src/executable.js"
import { ClaudeCodeContext } from "../src/context.js"
import { ClaudeCodeHostTools } from "../src/host-tools.js"
import { ClaudeCodePolicyHooks } from "../src/policy-hooks.js"
import fs from "node:fs"
import path from "node:path"

// No credentials or live endpoints: every CLI subprocess gets an isolated HOME,
// config directory and a fake key, and its sole API endpoint is loopback.
const resolved = ClaudeCodeExecutable.resolveWith({ env: process.env, platform: process.platform })
const executable = "path" in resolved ? fs.realpathSync(resolved.path) : undefined
// Follow PATH's real target: the test runner replaces HOME, but keeps PATH.
const pinned = executable && path.join(path.dirname(executable), "2.1.280")
const pinnedAvailable = pinned !== undefined && fs.existsSync(pinned)
const compactionExecutable = pinnedAvailable ? pinned : executable
const compactionVersion = pinnedAvailable ? "2.1.280" : "resolved PATH CLI"
const MODEL = "claude-sonnet-4-5"

const events = (blocks: Record<string, unknown>[], stop: string, index: number, inputTokens = 10) => [
  {
    type: "message_start",
    message: {
      id: `msg_fixture_${index}`,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  },
  ...blocks.flatMap((block, index) => [
    {
      type: "content_block_start",
      index,
      content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index,
      delta:
        block.type === "tool_use"
          ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          : { type: "text_delta", text: block.text },
    },
    { type: "content_block_stop", index },
  ]),
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 15 } },
  { type: "message_stop" },
]

const fixture = (
  blocks: { block?: Record<string, unknown>; blocks?: Record<string, unknown>[]; stop: string; inputTokens?: number }[],
) => {
  const seen: any[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "HEAD") return new Response(null, { status: 200 })
      if (new URL(request.url).pathname !== "/v1/messages")
        return Response.json({ error: { message: "unexpected path" } }, { status: 404 })
      const body = await request.json()
      seen.push(body)
      const script = blocks[seen.length - 1]
      if (!script) return Response.json({ error: { message: "unscripted request" } }, { status: 500 })
      return new Response(
        events(script.blocks ?? [script.block!], script.stop, seen.length, script.inputTokens)
          .map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`)
          .join(""),
        {
          headers: { "content-type": "text/event-stream", "request-id": `req_fixture_${seen.length}` },
        },
      )
    },
  })
  return { server, seen, url: `http://127.0.0.1:${server.port}` }
}

const run = async (input: {
  blocks: { block?: Record<string, unknown>; blocks?: Record<string, unknown>[]; stop: string; inputTokens?: number }[]
  mcpServers?: Record<string, ReturnType<typeof ClaudeCodeHostTools.makeServer>>
  hooks?: Parameters<typeof query>[0]["options"] extends infer O
    ? NonNullable<O> extends { hooks?: infer H }
      ? H
      : never
    : never
  bypass?: boolean
  turns?: string[]
  binary?: string
  env?: Record<string, string>
}) => {
  const upstream = fixture(input.blocks)
  const root = fs.mkdtempSync("/tmp/redsun/claude-runtime-")
  const cwd = path.join(root, "work")
  const config = path.join(root, "config")
  fs.mkdirSync(cwd)
  fs.mkdirSync(config)
  const controller = new AbortController()
  const messages: any[] = []
  const turns = input.turns ?? ["Follow the fixture's tool request, then finish."]
  let next: (() => void) | undefined
  const prompt =
    turns.length === 1
      ? turns[0]!
      : (async function* () {
          for (const [index, text] of turns.entries()) {
            if (index) await new Promise<void>((resolve) => (next = resolve))
            yield { type: "user" as const, message: { role: "user" as const, content: text }, parent_tool_use_id: null }
          }
        })()
  const native = query({
    prompt,
    options: {
      pathToClaudeCodeExecutable: input.binary ?? executable!,
      cwd,
      model: MODEL,
      maxTurns: 3,
      settingSources: [],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_API_KEY: "sk-ant-synthetic-fixture-not-a-credential",
        ANTHROPIC_BASE_URL: upstream.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        ...input.env,
      },
      abortController: controller,
      permissionMode: input.bypass ? "bypassPermissions" : "default",
      allowDangerouslySkipPermissions: input.bypass === true,
      mcpServers: input.mcpServers,
      hooks: input.hooks,
    },
  })
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    for await (const message of native) {
      messages.push(message)
      if (message.type === "result") {
        if (messages.filter((item) => item.type === "result").length >= turns.length) break
        next?.()
        next = undefined
      }
    }
    return { messages, seen: upstream.seen }
  } finally {
    clearTimeout(timeout)
    controller.abort()
    native.close()
    upstream.server.stop(true)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(!executable)("Claude Code installed CLI / SDK via synthetic upstream", () => {
  it(`delivers SessionStart compact context before the first post-compact model request (${compactionVersion})`, async () => {
    const sentinel = "HOST_RESTORED_AFTER_COMPACT_SENTINEL"
    const seen: string[] = []
    const tracker = new ClaudeCodeContext.Tracker()
    const restore = ClaudeCodeContext.partition((commit) =>
      ClaudeCodeContext.compact(
        async () =>
          tracker.prepare("ses", {
            agent: { id: "review", system: "Review carefully." },
            isWorker: false,
            freshProcess: true,
            files: [{ path: "/fixture/AGENTS.md", content: ".".repeat(30_000) + sentinel }],
          }),
        () => seen.push("compact"),
        () => true,
        commit,
      ),
    )
    const result = await run({
      binary: compactionExecutable,
      turns: ["Reply briefly.", "/compact", "Reply after compaction."],
      blocks: [
        { block: { type: "text", text: "First reply." }, stop: "end_turn" },
        { block: { type: "text", text: "Summary of the conversation." }, stop: "end_turn" },
        { block: { type: "text", text: "Final reply." }, stop: "end_turn" },
      ],
      hooks: {
        SessionStart: [{ matcher: "compact", hooks: restore }],
      },
    })
    expect(seen).toEqual(["compact"])
    expect(result.messages.some((item) => item.type === "system" && item.subtype === "compact_boundary")).toBe(true)
    expect(result.seen).toHaveLength(3)
    expect(JSON.stringify(result.seen[1])).not.toContain(sentinel) // the summary request precedes SessionStart
    expect(JSON.stringify(result.seen[2])).toContain(sentinel) // first request after the compact boundary
  }, 20_000)

  it(`restores compact context before an automatic same-turn continuation (${compactionVersion})`, async () => {
    const sentinel = "HOST_AUTO_COMPACT_SENTINEL"
    const seen: string[] = []
    const tracker = new ClaudeCodeContext.Tracker()
    const restore = ClaudeCodeContext.partition((commit) =>
      ClaudeCodeContext.compact(
        async () =>
          tracker.prepare("ses", {
            agent: { id: "review", system: "Review carefully." },
            isWorker: false,
            freshProcess: true,
            files: [{ path: "/fixture/AGENTS.md", content: ".".repeat(30_000) + sentinel }],
            answers: '<redsun-retained-answers>Historical answer: "Which shape?" = "Circle"</redsun-retained-answers>',
          }),
        () => seen.push("compact"),
        () => true,
        commit,
      ),
    )
    const server = ClaudeCodeHostTools.makeServer({
      definitions: [
        {
          type: "tool",
          name: "skill",
          description: "Load a skill",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      ],
      execute: async () => ({ content: [{ type: "text", text: "tool result" }] }),
    })
    const result = await run({
      binary: compactionExecutable,
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "20000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "1" },
      bypass: true,
      mcpServers: { redsun: server },
      blocks: [
        {
          block: { type: "tool_use", id: "toolu_compact_skill", name: "mcp__redsun__skill", input: { id: "test" } },
          stop: "tool_use",
          inputTokens: 199000,
        },
        { block: { type: "text", text: "Summary of the conversation." }, stop: "end_turn" },
        { block: { type: "text", text: "Continued." }, stop: "end_turn" },
      ],
      hooks: { SessionStart: [{ matcher: "compact", hooks: restore }] },
    })
    expect(result.messages.at(-1)?.subtype).toBe("success")
    expect(result.messages.some((item) => item.type === "system" && item.subtype === "compact_boundary")).toBe(true)
    expect(seen).toEqual(["compact"])
    expect(result.messages.filter((item) => item.type === "result")).toHaveLength(1)
    expect(result.seen).toHaveLength(3)
    expect(JSON.stringify(result.seen[1])).not.toContain(sentinel)
    expect(JSON.stringify(result.seen[2])).toContain(sentinel)
    expect(JSON.stringify(result.seen[2])).toContain("Circle")
  }, 20_000)
  it("delivers host context through the native prompt-submit hook", async () => {
    let submitted = 0
    const context = "HOST_CONTEXT_HOOK_SENTINEL: the qualification skill is available."
    const result = await run({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              async (event) => {
                expect(event.hook_event_name).toBe("UserPromptSubmit")
                submitted++
                return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }
              },
            ],
          },
        ],
      },
      blocks: [{ block: { type: "text", text: "Context received." }, stop: "end_turn" }],
    })
    expect(submitted).toBe(1)
    expect(result.messages.at(-1)?.subtype).toBe("success")
    expect(JSON.stringify(result.seen[0])).toContain(context)
  }, 20_000)

  it("calls the canonical MCP skill and sends its full textual instructions back to the model", async () => {
    const canonical = "SKILL_BODY_CANONICAL_SENTINEL: use the redsun skill instructions"
    const metadata = { name: "fixture-skill", directory: "/fixture" }
    const completed: unknown[] = []
    const post: unknown[] = []
    const server = ClaudeCodeHostTools.makeServer({
      definitions: [
        {
          type: "tool",
          name: "skill",
          description: "Load a skill",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      ],
      execute: async () => ({
        content: [{ type: "text", text: canonical }],
        output: { output: "different machine field" },
        metadata,
      }),
      onResult: (result) => completed.push(result),
    })
    const result = await run({
      bypass: true,
      mcpServers: { redsun: server },
      hooks: {
        PostToolUse: [
          {
            hooks: [
              async (event) => {
                post.push(event)
                return {}
              },
            ],
          },
        ],
      },
      blocks: [
        {
          block: {
            type: "tool_use",
            id: "toolu_fixture_skill",
            name: "mcp__redsun__skill",
            input: { id: "fixture-skill" },
          },
          stop: "tool_use",
        },
        { block: { type: "text", text: "Skill received." }, stop: "end_turn" },
      ],
    })
    expect(result.messages.at(-1)?.subtype).toBe("success")
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ result: { metadata } })
    expect(post).toHaveLength(1)
    expect(post[0]).toMatchObject({ tool_name: "mcp__redsun__skill", tool_use_id: "toolu_fixture_skill" })
    expect(post[0]).toMatchObject({ tool_response: [{ type: "text", text: canonical }] })
    expect(completed[0]).toMatchObject({ nativeToolUseID: "toolu_fixture_skill" })
    expect((post[0] as any).tool_response).not.toHaveProperty("_meta")
    expect(result.seen).toHaveLength(2)
    const delivered = result.messages.find(
      (message) => message.type === "user" && message.message?.content?.[0]?.type === "tool_result",
    )
    expect(JSON.stringify(delivered?.message?.content)).toContain(canonical)
    expect(JSON.stringify(result.seen[1])).toContain(canonical)
    expect(JSON.stringify(result.seen[1])).not.toContain("different machine field")
  }, 20_000)

  it("correlates identical parallel host calls by native tool-use ID, not arguments or MCP request ID", async () => {
    const completed: { nativeToolUseID?: string; requestId: string; result: unknown }[] = []
    const server = ClaudeCodeHostTools.makeServer({
      definitions: [
        {
          type: "tool",
          name: "todowrite",
          description: "Store todos",
          inputSchema: { type: "object", properties: { todos: { type: "array" } } },
        },
      ],
      execute: async ({ nativeToolUseID }) => ({
        content: [{ type: "text", text: "one todo" }],
        metadata: { todos: [{ content: nativeToolUseID, status: "completed", priority: "low" }] },
      }),
      onResult: ({ nativeToolUseID, requestId, result }) => completed.push({ nativeToolUseID, requestId, result }),
    })
    const ids = ["toolu_fixture_todo_a", "toolu_fixture_todo_b"]
    const post: unknown[] = []
    const result = await run({
      bypass: true,
      mcpServers: { redsun: server },
      hooks: {
        PostToolUse: [
          {
            hooks: [
              async (event) => {
                post.push(event)
                return {}
              },
            ],
          },
        ],
      },
      blocks: [
        {
          blocks: ids.map((id) => ({ type: "tool_use", id, name: "mcp__redsun__todowrite", input: { todos: [] } })),
          stop: "tool_use",
        },
        { block: { type: "text", text: "Todos recorded." }, stop: "end_turn" },
      ],
    })
    expect(result.messages.at(-1)?.subtype).toBe("success")
    expect(completed).toHaveLength(2)
    expect(completed.map((entry) => entry.nativeToolUseID).sort()).toEqual(ids)
    expect(new Set(completed.map((entry) => entry.requestId)).size).toBe(2)
    expect(completed.every((entry) => entry.requestId !== entry.nativeToolUseID)).toBe(true)
    for (const entry of completed)
      expect(entry.result).toMatchObject({ metadata: { todos: [{ content: entry.nativeToolUseID }] } })
    expect(post).toHaveLength(2)
    expect(post.map((entry: any) => entry.tool_use_id).sort()).toEqual(ids)
  }, 20_000)

  it("enforces the host PreToolUse denial even under native bypassPermissions", async () => {
    const evaluated: string[] = []
    const hooks = ClaudeCodePolicyHooks.make({
      worktree: "/tmp/redsun",
      agent: () => "build",
      policy: async (action) => {
        evaluated.push(action)
        return { effect: "deny", message: "HOST_POLICY_DENIED_SENTINEL" }
      },
      assert: async () => ({ ok: true }),
      form: async () => undefined,
      exitPlan: async () => ({ ok: false }),
    })
    try {
      const result = await run({
        bypass: true,
        hooks: { PreToolUse: [{ hooks: [hooks.preToolUse] }] },
        blocks: [
          {
            block: {
              type: "tool_use",
              id: "toolu_fixture_bash",
              name: "Bash",
              input: { command: "printf FORBIDDEN_EXECUTION_SENTINEL" },
            },
            stop: "tool_use",
          },
          { block: { type: "text", text: "Denied." }, stop: "end_turn" },
        ],
      })
      expect(result.messages.at(-1)?.subtype).toBe("success")
      expect(evaluated).toContain("shell")
      const denied = result.messages.find(
        (message) => message.type === "user" && message.message?.content?.[0]?.type === "tool_result",
      )
      expect(denied?.message?.content?.[0]).toMatchObject({ is_error: true })
      expect(JSON.stringify(result.seen[1])).toContain("HOST_POLICY_DENIED_SENTINEL")
      expect(JSON.stringify(result.seen[1])).not.toContain("FORBIDDEN_EXECUTION_SENTINEL\n")
    } finally {
      hooks.clear()
    }
  }, 20_000)
})
