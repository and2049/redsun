import { describe, expect, it } from "bun:test"
import { ClaudeCodeHostTools } from "@opencode/core/plugin/redsun/claude-code/host-tools"
import { Effect } from "effect"

const handlers = (server: ReturnType<typeof ClaudeCodeHostTools.makeServer>) => {
  const map = (server.instance.server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers
  return {
    list: () => map.get("tools/list")!({ method: "tools/list", params: {} }, {}),
    call: (name: string, args: object, signal = new AbortController().signal) =>
      map.get("tools/call")!({ method: "tools/call", params: { name, arguments: args } }, { requestId: 42, signal }),
  }
}

describe("Claude Code canonical host MCP bridge", () => {
  const schema = {
    type: "object" as const,
    additionalProperties: false,
    required: ["todos"],
    properties: { todos: { type: "array", minItems: 1, items: { $ref: "#/$defs/Todo" } } },
    $defs: { Todo: { type: "object", required: ["content"] } },
  }

  it("advertises only available selected definitions without weakening JSON schema", async () => {
    const { list, call } = handlers(
      ClaudeCodeHostTools.makeServer({
        definitions: [
          { type: "tool", name: "todowrite", description: "canonical todo", inputSchema: schema },
          { type: "tool", name: "shell", description: "not bridged", inputSchema: {} },
        ],
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      }),
    )
    expect(await list()).toEqual({ tools: [{ name: "todowrite", description: "canonical todo", inputSchema: schema }] })
    expect((await call("shell", {})).isError).toBe(true)
  })

  it("executes once and preserves authoritative text and metadata even with structured host output", async () => {
    const seen: unknown[] = []
    const results: unknown[] = []
    const { call } = handlers(
      ClaudeCodeHostTools.makeServer({
        definitions: [{ type: "tool", name: "subagent", description: "delegate", inputSchema: { type: "object" } }],
        execute: async (input) => {
          seen.push(input)
          return {
            output: { sessionID: "ses_child" },
            content: [{ type: "text", text: "worker done" }],
            metadata: { duration: 5 },
          }
        },
        onResult: (result) => results.push(result),
      }),
    )
    const value = await call("subagent", { background: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ name: "subagent", args: { background: true }, requestId: "42" })
    expect(value).toEqual({
      content: [{ type: "text", text: "worker done" }],
      _meta: { "redsun/metadata": { duration: 5 } },
    })
    expect(results).toHaveLength(1)
  })

  it("returns host errors as MCP errors and does not swallow cancellation", async () => {
    const { call } = handlers(
      ClaudeCodeHostTools.makeServer({
        definitions: [{ type: "tool", name: "skill", description: "load", inputSchema: { type: "object" } }],
        execute: async () => {
          throw new Error("Permission denied")
        },
      }),
    )
    expect(await call("skill", {})).toEqual({ content: [{ type: "text", text: "Permission denied" }], isError: true })
    const controller = new AbortController()
    controller.abort()
    expect(call("skill", {}, controller.signal)).rejects.toThrow("Permission denied")
  })

  it("uses the captured snapshot and turn context instead of latest session state", async () => {
    const calls: unknown[] = []
    const snapshot = {
      definitions: [
        {
          type: "tool" as const,
          name: "worker_model",
          description: "choose",
          inputSchema: { type: "object" as const },
        },
      ],
      execute: (input: unknown) =>
        Effect.sync(() => {
          calls.push(input)
          return { content: [{ type: "text" as const, text: "chosen" }] }
        }),
    }
    const host = ClaudeCodeHostTools.fromSnapshot({
      snapshot: snapshot as never,
      sessionID: "ses_parent" as never,
      agent: "build" as never,
      messageID: "msg_turn" as never,
    })
    expect(await handlers(ClaudeCodeHostTools.makeServer(host)).call("worker_model", {})).toEqual({
      content: [{ type: "text", text: "chosen" }],
    })
    expect(calls).toMatchObject([
      {
        sessionID: "ses_parent",
        agent: "build",
        messageID: "msg_turn",
        call: { name: "worker_model", id: "claude-code-mcp-msg_turn-42", input: {} },
      },
    ])
    await host.execute({
      name: "worker_model",
      args: {},
      requestId: "43",
      nativeToolUseID: "toolu_native_43",
      signal: new AbortController().signal,
    })
    expect(calls[1]).toMatchObject({ call: { id: "toolu_native_43" } })
  })

  it("rebinds a persistent server between turns and freezes each in-flight execution", async () => {
    const calls: string[] = []
    let release!: () => void
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const makeHost = (turn: string) => ({
      definitions: [
        { type: "tool" as const, name: "skill", description: turn, inputSchema: { type: "object" as const } },
      ],
      execute: async () => {
        calls.push(turn)
        if (turn === "first") {
          started()
          await pending
        }
        return { content: [{ type: "text" as const, text: `instructions for ${turn}` }] }
      },
    })
    let current: ReturnType<typeof makeHost> | undefined
    const server = handlers(ClaudeCodeHostTools.makeServer(() => current))
    expect(await server.list()).toEqual({ tools: [] })
    expect(await server.call("skill", {})).toMatchObject({ isError: true })
    current = makeHost("first")
    expect((await server.list()).tools[0].description).toBe("first")
    const first = server.call("skill", {})
    await began
    current = makeHost("second")
    expect((await server.list()).tools[0].description).toBe("second")
    release()
    expect((await first).content[0].text).toBe("instructions for first")
    expect((await server.call("skill", {})).content[0].text).toBe("instructions for second")
    expect(calls).toEqual(["first", "second"])
    current = undefined
    expect(await server.call("skill", {})).toMatchObject({ isError: true })
  })

  it("interrupts a captured host snapshot on cancellation without publishing a late result", async () => {
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const results: unknown[] = []
    const host = ClaudeCodeHostTools.fromSnapshot({
      snapshot: {
        definitions: [{ type: "tool", name: "worker_model", description: "choose", inputSchema: { type: "object" } }],
        execute: () =>
          Effect.gen(function* () {
            started()
            yield* Effect.never
            return { content: [{ type: "text" as const, text: "late" }] }
          }),
      } as never,
      sessionID: "ses_parent" as never,
      agent: "build" as never,
      messageID: "msg_turn" as never,
      onResult: (result) => results.push(result),
    })
    const controller = new AbortController()
    const call = handlers(ClaudeCodeHostTools.makeServer(host)).call("worker_model", {}, controller.signal)
    await began
    controller.abort()
    await expect(call).rejects.toThrow()
    expect(results).toEqual([])
  })
})
