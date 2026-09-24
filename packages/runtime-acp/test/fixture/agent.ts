// A scripted ACP agent over stdio. The prompt text picks the behaviour.
import { Readable, Writable } from "node:stream"
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type McpServer,
} from "@agentclientprotocol/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
)

let sessions = 0
const modes = new Map<string, string>()
const cancelled = new Set<string>()
const received: string[] = []
const servers = new Map<string, McpServer[]>()

/** Connects to the session's host MCP server the way an agent would. */
const mcp = async (sessionId: string) => {
  const server = servers.get(sessionId)?.find((item) => "url" in item && item.name === "redsun")
  if (!server || !("url" in server)) return undefined
  const client = new Client({ name: "fake-acp", version: "1" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: Object.fromEntries(server.headers.map((header) => [header.name, header.value])) },
    }),
  )
  return client
}
// Launched with the trust flag, the agent approves its own tools; FAKE_ACP_NO_LOAD hides session/load.
const trusted = process.argv.includes("--trust-all-tools")
const loadable = process.env.FAKE_ACP_NO_LOAD !== "1"
const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "trust", name: "Trust all tools" },
  ],
}

new AgentSideConnection((connection) => {
  const say = (sessionId: string, text: string) =>
    connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    })
  const agent: Agent = {
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: loadable, mcpCapabilities: { http: process.env.FAKE_ACP_NO_HTTP !== "1" } },
    }),
    newSession: async (params) => {
      const sessionId = `acp_${++sessions}`
      modes.set(sessionId, "default")
      servers.set(sessionId, params.mcpServers)
      return { sessionId, modes: MODES }
    },
    ...(loadable
      ? {
          loadSession: async (params: { sessionId: string; mcpServers: McpServer[] }) => {
            modes.set(params.sessionId, "default")
            servers.set(params.sessionId, params.mcpServers)
            // A real agent replays the loaded conversation; the client must not forward it.
            await say(params.sessionId, "REPLAYED HISTORY")
            return { modes: MODES }
          },
        }
      : {}),
    authenticate: async () => ({}),
    setSessionMode: async (params) => {
      modes.set(params.sessionId, params.modeId)
      return {}
    },
    cancel: async (params) => {
      cancelled.add(params.sessionId)
    },
    prompt: async (params) => {
      const sessionId = params.sessionId
      const text = params.prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")
      received.push(text)
      if (text.includes("think")) {
        await connection.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" } },
        })
      }
      if (text.includes("tool")) {
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_read",
            title: "Read README.md",
            kind: "read",
            status: "pending",
            rawInput: { path: "README.md" },
            locations: [{ path: "README.md" }],
          },
        })
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_read",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "# readme body" } }],
          },
        })
      }
      if (text.includes("permission")) {
        const answer = await connection.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: "call_edit",
            title: "Edit src/a.ts",
            kind: "edit",
            locations: [{ path: "src/a.ts" }],
          },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        })
        const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId === "yes"
        await say(sessionId, allowed ? "ALLOWED" : "DENIED")
        return { stopReason: "end_turn" }
      }
      if (text.includes("crash")) {
        await say(sessionId, "about to fail")
        process.exit(3)
      }
      if (text.includes("slow")) {
        await say(sessionId, "working")
        for (let waited = 0; waited < 5_000 && !cancelled.has(sessionId); waited += 10)
          await new Promise((resolve) => setTimeout(resolve, 10))
        return { stopReason: cancelled.has(sessionId) ? "cancelled" : "end_turn" }
      }
      if (text.includes("mode?")) {
        await say(sessionId, `MODE=${modes.get(sessionId)}`)
        return { stopReason: "end_turn" }
      }
      if (text.includes("tools?")) {
        const client = await mcp(sessionId)
        const listed = client ? (await client.listTools()).tools.map((tool) => tool.name).join(",") : "none"
        await client?.close()
        await say(sessionId, `TOOLS=${listed}`)
        return { stopReason: "end_turn" }
      }
      if (text.includes("hostcall")) {
        // As Kiro reports an MCP tool: identity in _meta, a bookkeeping field in the input.
        const args = { todos: [{ content: "ship it", status: "pending" }] }
        const toolCallId = "call_host"
        const report = {
          toolCallId,
          title: "Running: @redsun/todowrite",
          rawInput: { __tool_use_purpose: "Track the work.", ...args },
          _meta: { kiro: { toolName: "todowrite", mcpServerName: "redsun" } },
        }
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call", ...report } })
        const answer = await connection.requestPermission({
          sessionId,
          toolCall: report,
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        })
        if (answer.outcome.outcome !== "selected" || answer.outcome.optionId !== "yes") {
          await say(sessionId, "HOST TOOL DENIED")
          return { stopReason: "end_turn" }
        }
        const client = await mcp(sessionId)
        const result = client ? await client.callTool({ name: "todowrite", arguments: args }) : undefined
        await client?.close()
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            kind: "other",
            status: result?.isError ? "failed" : "completed",
            rawOutput: { items: [{ Json: result ?? null }] },
          },
        })
        await say(sessionId, "HOST TOOL DONE")
        return { stopReason: "end_turn" }
      }
      if (text.includes("trust?")) {
        await say(sessionId, `TRUSTED=${trusted} SESSION=${sessionId} TURNS=${received.length}`)
        return { stopReason: "end_turn" }
      }
      if (text.includes("echo")) {
        await say(sessionId, `SESSION=${sessionId} TURNS=${received.length} PROMPT=${text}`)
        return { stopReason: "end_turn" }
      }
      await connection.sessionUpdate({ sessionId, update: { sessionUpdate: "usage_update", used: 1234, size: 200000 } })
      await say(sessionId, "Hello from ")
      await say(sessionId, "the fake agent")
      return { stopReason: "end_turn" }
    },
  }
  return agent
}, stream)
