import { describe, expect, it } from "bun:test"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Tool } from "@opencode/core/tool"
import { CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { ClaudeCodeContext } from "@redsun/runtime-claude-code/context"
import { ClaudeCodeExecutable } from "@redsun/runtime-claude-code/executable"
import { ClaudeCodeHostTools } from "@redsun/runtime-claude-code/host-tools"
import { hostFromSnapshot } from "./lib/claude-code"
import { DelegateHost } from "@opencode/core/delegate-host"
import { Effect, Schema } from "effect"
import fs from "node:fs"
import path from "node:path"

// This is an installed-CLI qualification, not an external MCP authentication test.
// A local fixture registers ordinary canonical host tools, including one shaped
// like a connected direct MCP registration. All CLI API traffic goes to loopback.
const resolved = ClaudeCodeExecutable.resolveWith({ env: process.env, platform: process.platform })
const executable = "path" in resolved ? fs.realpathSync(resolved.path) : undefined
const MODEL = "claude-sonnet-4-5"

const events = (block: Record<string, unknown>, stop: string, index: number) => [
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
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta:
      block.type === "tool_use"
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text },
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 15 } },
  { type: "message_stop" },
]

describe.skipIf(!executable)("Claude Code installed CLI / canonical MCP and Code Mode bridge", () => {
  it("returns direct and nested Code Mode results to subsequent model requests with native tool IDs", async () => {
    const direct = "DIRECT_MCP_BRIDGE_RESULT_SENTINEL"
    const nested = "NESTED_CODE_MODE_RESULT_SENTINEL"
    const root = fs.mkdtempSync("/tmp/redsun/claude-mcp-runtime-")
    const cwd = path.join(root, "work")
    const config = path.join(root, "config")
    fs.mkdirSync(cwd)
    fs.mkdirSync(config)
    const seen: any[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "HEAD") return new Response(null, { status: 200 })
        if (new URL(request.url).pathname !== "/v1/messages") return new Response(null, { status: 404 })
        seen.push(await request.json())
        const scripts = [
          {
            block: {
              type: "tool_use",
              id: "toolu_direct_fixture",
              name: "mcp__redsun__fixture_mcp_echo",
              input: { text: "direct" },
            },
            stop: "tool_use",
          },
          {
            block: {
              type: "tool_use",
              id: "toolu_execute_fixture",
              name: "mcp__redsun__execute",
              input: {
                code: 'const found = search({query:"nested fixture"}); return {paths: found.items.map(item => item.path), result: await tools.fixture.nested({text:"code"})}',
              },
            },
            stop: "tool_use",
          },
          { block: { type: "text", text: "Both results received." }, stop: "end_turn" },
        ]
        const script = scripts[seen.length - 1]
        if (!script) return Response.json({ error: { message: "unscripted request" } }, { status: 500 })
        return new Response(
          events(script.block, script.stop, seen.length)
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream", "request-id": `req_fixture_${seen.length}` } },
        )
      },
    })
    const controller = new AbortController()
    let native: ReturnType<typeof query> | undefined
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const tools = yield* Tool.Service
          yield* tools.transform((editor) => {
            editor.namespace({ name: "fixture", description: "Fixture Code Mode tools" })
            editor.add({
              name: "echo",
              options: { namespace: "fixture_mcp", codemode: false },
              description: "A registered direct MCP fixture tool",
              input: Schema.Struct({ text: Schema.String }),
              output: Schema.String,
              execute: ({ text }, context) =>
                Effect.succeed({ output: `${direct}:${text}`, metadata: { hostCallID: context.id } }),
            })
            editor.add({
              name: "nested",
              options: { namespace: "fixture" },
              description: "A nested fixture tool discoverable with search",
              input: Schema.Struct({ text: Schema.String }),
              output: Schema.String,
              execute: ({ text }) => Effect.succeed({ output: `${nested}:${text}` }),
            })
          })
          const snapshot = yield* tools.snapshot()
          const definitions = ClaudeCodeHostTools.select({
            definitions: snapshot.definitions,
            available: snapshot.definitions.map((item) => item.name),
            direct: DelegateHost.directNames([{ server: "fixture.mcp", name: "echo", codemode: false }] as never),
          })
          expect(definitions.map((item) => item.name)).toEqual(["fixture_mcp_echo", "execute"])
          const calls: Array<{ name: string; nativeToolUseID?: string; metadata?: Tool.Metadata }> = []
          const allowed = new Set(definitions.map((item) => item.name))
          const host = hostFromSnapshot({
            snapshot,
            sessionID: "ses_fixture" as never,
            agent: "build" as never,
            messageID: "msg_fixture" as never,
            allowed,
            onResult: (item) =>
              calls.push({ name: item.name, nativeToolUseID: item.nativeToolUseID, metadata: item.result.metadata }),
          })
          const server = ClaudeCodeHostTools.makeServer({ ...host, definitions })
          const tracker = new ClaudeCodeContext.Tracker()
          const delivery = tracker.prepare("ses_fixture", {
            agent: { id: "build" },
            isWorker: false,
            freshProcess: true,
            codeMode: DelegateHost.codeMode(CodeModeCatalog.summarize(snapshot.codeModeCatalog!)),
          })
          native = query({
            prompt: "Follow the fixture's tool requests and return the results.",
            options: {
              pathToClaudeCodeExecutable: executable!,
              cwd,
              model: MODEL,
              maxTurns: 4,
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
              mcpServers: { redsun: server },
              hooks: { UserPromptSubmit: [{ hooks: [ClaudeCodeContext.submit(() => delivery)] }] },
            },
          })
          const messages = yield* Effect.promise(async () => {
            const received: any[] = []
            for await (const message of native!) {
              received.push(message)
              if (message.type === "result") break
            }
            return received
          })
          expect(messages.at(-1)?.subtype).toBe("success")
          expect(seen).toHaveLength(3)
          expect(JSON.stringify(seen[0])).toContain("fixture.nested")
          expect(JSON.stringify(seen[1])).toContain(`${direct}:direct`)
          expect(JSON.stringify(seen[1])).toContain("toolu_direct_fixture")
          expect(JSON.stringify(seen[2])).toContain(`${nested}:code`)
          expect(JSON.stringify(seen[2])).toContain("toolu_execute_fixture")
          expect(JSON.stringify(seen[2])).toContain("fixture.nested") // search returned the canonical path
          expect(calls).toMatchObject([
            {
              name: "fixture_mcp_echo",
              nativeToolUseID: "toolu_direct_fixture",
              metadata: { hostCallID: "toolu_direct_fixture" },
            },
            {
              name: "execute",
              nativeToolUseID: "toolu_execute_fixture",
              metadata: {
                toolCalls: [
                  { tool: "search", status: "completed" },
                  { tool: "fixture.nested", status: "completed" },
                ],
              },
            },
          ])
        }).pipe(
          Effect.scoped,
          Effect.provide(
            AppNodeBuilder.build(Tool.node, [
              Location.node.replace(Location.boundNode({ directory: AbsolutePath.make(cwd) })),
            ]),
          ),
        ),
      )
    } finally {
      clearTimeout(timeout)
      controller.abort()
      native?.close()
      upstream.stop(true)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 22_000)
})
