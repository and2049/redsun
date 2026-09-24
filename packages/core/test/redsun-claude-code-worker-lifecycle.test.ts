import { describe, expect, it } from "bun:test"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeCodeExecutable } from "@opencode/core/plugin/redsun/claude-code/executable"
import { ClaudeCodeHostTools } from "@opencode/core/plugin/redsun/claude-code/host-tools"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"

const resolved = ClaudeCodeExecutable.resolveWith({
  env: process.env,
  platform: process.platform,
})
const executable = "path" in resolved && fs.existsSync(resolved.path) ? fs.realpathSync(resolved.path) : undefined
const model = "claude-sonnet-4-5"

const events = (blocks: Record<string, unknown>[], stop: string, index: number) => [
  {
    type: "message_start",
    message: {
      id: `msg_worker_${index}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
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
          ? {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            }
          : { type: "text_delta", text: block.text },
    },
    { type: "content_block_stop", index },
  ]),
  {
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 15 },
  },
  { type: "message_stop" },
]

describe.skipIf(!executable)("Claude Code worker lifecycle through the installed CLI and host MCP bridge", () => {
  it("attributes parallel subagent calls to the captured turn and forwards a failed worker as a tool error", async () => {
    const root = fs.mkdtempSync("/tmp/redsun/claude-worker-lifecycle-")
    const cwd = path.join(root, "work")
    const config = path.join(root, "config")
    let upstream: ReturnType<typeof Bun.serve> | undefined
    let native: ReturnType<typeof query> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    try {
      fs.mkdirSync(cwd)
      fs.mkdirSync(config)
      const requestsSeen: unknown[] = []
      const calls: {
        call: { id: string; name: string; input: { description: string } }
        messageID: string
      }[] = []
      const reported: unknown[] = []
      const host = ClaudeCodeHostTools.fromSnapshot({
        snapshot: {
          definitions: [
            {
              type: "tool",
              name: "subagent",
              description: "Delegate work to a worker",
              inputSchema: {
                type: "object",
                properties: { description: { type: "string" } },
                required: ["description"],
              },
            },
          ],
          execute: (input: (typeof calls)[number]) =>
            Effect.sync(() => {
              calls.push(input)
              if (input.call.input.description === "fails") throw new Error("WORKER_FAILED_SENTINEL")
              return {
                content: [{ type: "text" as const, text: "WORKER_SUCCEEDED_SENTINEL" }],
              }
            }),
        } as never,
        sessionID: "ses_worker_parent" as never,
        agent: "build" as never,
        messageID: "msg_captured_turn" as never,
        onResult: (result) => reported.push(result),
      })
      upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method === "HEAD") return new Response(null, { status: 200 })
          if (new URL(request.url).pathname !== "/v1/messages") return new Response(null, { status: 404 })
          requestsSeen.push(await request.json())
          const index = ++requests
          const blocks =
            index === 1
              ? [
                  {
                    type: "tool_use",
                    id: "toolu_worker_ok",
                    name: "mcp__redsun__subagent",
                    input: { description: "ok" },
                  },
                  {
                    type: "tool_use",
                    id: "toolu_worker_fail",
                    name: "mcp__redsun__subagent",
                    input: { description: "fails" },
                  },
                ]
              : [{ type: "text", text: "Workers settled." }]
          if (index > 2) return Response.json({ error: { message: "unscripted request" } }, { status: 500 })
          const stream = events(blocks, index === 1 ? "tool_use" : "end_turn", index)
          return new Response(
            stream.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
            {
              headers: {
                "content-type": "text/event-stream",
                "request-id": `req_worker_${index}`,
              },
            },
          )
        },
      })
      let requests = 0
      timeout = setTimeout(() => controller.abort(), 12_000)
      native = query({
        prompt: "Follow the fixture's worker calls, then finish.",
        options: {
          pathToClaudeCodeExecutable: executable!,
          cwd,
          model,
          maxTurns: 3,
          settingSources: [],
          env: {
            PATH: process.env.PATH ?? "",
            HOME: root,
            CLAUDE_CONFIG_DIR: config,
            ANTHROPIC_API_KEY: "sk-ant-synthetic-fixture-not-a-credential",
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.port}`,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_TELEMETRY: "1",
            DISABLE_ERROR_REPORTING: "1",
          },
          abortController: controller,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          mcpServers: { redsun: ClaudeCodeHostTools.makeServer(host) },
        },
      })
      const messages: any[] = []
      for await (const message of native) {
        messages.push(message)
        if (message.type === "result") break
      }
      expect(messages.at(-1)?.subtype).toBe("success")
      expect(requests).toBe(2)
      expect(calls).toHaveLength(2)
      expect(calls.map((entry) => entry.call.id).sort()).toEqual(["toolu_worker_fail", "toolu_worker_ok"])
      expect(calls.every((entry) => entry.messageID === "msg_captured_turn" && entry.call.name === "subagent")).toBe(
        true,
      )
      expect(reported).toHaveLength(1)
      expect(reported[0]).toMatchObject({
        nativeToolUseID: "toolu_worker_ok",
      })
      const results = messages.flatMap((message) =>
        message.type === "user" && Array.isArray(message.message?.content)
          ? message.message.content.filter((part: any) => part.type === "tool_result")
          : [],
      )
      expect(results).toHaveLength(2)
      expect(results.find((part: any) => part.tool_use_id === "toolu_worker_ok")?.is_error).not.toBe(true)
      expect(JSON.stringify(results.find((part: any) => part.tool_use_id === "toolu_worker_ok"))).toContain(
        "WORKER_SUCCEEDED_SENTINEL",
      )
      expect(results.find((part: any) => part.tool_use_id === "toolu_worker_fail")).toMatchObject({ is_error: true })
      expect(JSON.stringify(results.find((part: any) => part.tool_use_id === "toolu_worker_fail"))).toContain(
        "WORKER_FAILED_SENTINEL",
      )
      expect(JSON.stringify(requestsSeen[1])).toContain("WORKER_SUCCEEDED_SENTINEL")
      expect(JSON.stringify(requestsSeen[1])).toContain("WORKER_FAILED_SENTINEL")
    } finally {
      if (timeout) clearTimeout(timeout)
      controller.abort()
      try {
        native?.close()
      } finally {
        try {
          upstream?.stop(true)
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      }
    }
  }, 20_000)
})
