// A scripted ACP agent over stdio. The prompt text picks the behaviour.
import { readFileSync } from "node:fs"
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

// `agent.ts whoami` answers a sign-in check the way `kiro-cli whoami --format json` does.
if (process.argv.includes("whoami")) {
  if (process.env.FAKE_ACP_SIGNED_OUT === "1") {
    console.error("not logged in")
    process.exit(1)
  }
  console.log(JSON.stringify({ accountType: "BuilderId", email: "dev@example.com", region: 7 }))
  process.exit(0)
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
)

let sessions = 0
const modes = new Map<string, string>()
const cancelled = new Set<string>()
const received: string[] = []
let compacting = false
const v3 = process.env.FAKE_ACP_V3 === "1"
const requests: unknown[] = []
const servers = new Map<string, McpServer[]>()
// FAKE_ACP_MODELS picks how the agent reports its models: the standard config option or the
// unstable `models` field with `session/set_model`.
const modelStyle = process.env.FAKE_ACP_MODELS
const MODEL_LIST = [
  { id: "auto", name: "Auto" },
  { id: "fast", name: "Fast" },
]
const models = new Map<string, string>()
const modelFields = (sessionId: string) => {
  const current = models.get(sessionId) ?? "auto"
  if (modelStyle === "legacy")
    return {
      models: {
        currentModelId: current,
        availableModels: MODEL_LIST.map((model) => ({ modelId: model.id, name: model.name })),
      },
    }
  if (modelStyle === "config")
    return {
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select" as const,
          currentValue: current,
          options: MODEL_LIST.map((model) => ({ value: model.id, name: model.name })),
        },
      ],
    }
  return {}
}

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
  currentModeId: v3 && process.env.FAKE_ACP_BAD_PROFILE !== "1" ? "redsun" : "default",
  availableModes: [
    { id: "default", name: "Default" },
    ...(v3 ? [{ id: "redsun", name: "Redsun" }] : []),
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
      agentCapabilities: {
        loadSession: loadable,
        mcpCapabilities: { http: process.env.FAKE_ACP_NO_HTTP !== "1" },
        ...(v3 ? { _meta: { kiro: { extensionMethods: ["_kiro/session/compact"] } } } : {}),
      },
    }),
    newSession: async (params) => {
      requests.push({ method: "new", ...params })
      const sessionId = `acp_${++sessions}`
      modes.set(sessionId, "default")
      servers.set(sessionId, params.mcpServers)
      return { sessionId, modes: MODES, ...modelFields(sessionId) }
    },
    ...(loadable
      ? {
          loadSession: async (params: { sessionId: string; mcpServers: McpServer[] }) => {
            requests.push({ method: "load", ...params })
            if (process.env.FAKE_ACP_FAIL_LOAD === "1") throw new Error("Stored session is unavailable")
            modes.set(params.sessionId, "default")
            servers.set(params.sessionId, params.mcpServers)
            // A real agent replays the loaded conversation; the client must not forward it.
            await say(params.sessionId, "REPLAYED HISTORY")
            return { modes: MODES, ...modelFields(params.sessionId) }
          },
        }
      : {}),
    authenticate: async () => ({}),
    setSessionConfigOption: async (params) => {
      if (params.configId === "model" && typeof params.value === "string") models.set(params.sessionId, params.value)
      return modelFields(params.sessionId) as { configOptions: [] }
    },
    extMethod: async (method, params) => {
      if (method === "_kiro/session/compact") {
        if (process.env.FAKE_ACP_V3_COMPACT === "hang") await new Promise(() => {})
        if (process.env.FAKE_ACP_V3_COMPACT === "fail") return { success: false }
        if (process.env.FAKE_ACP_V3_COMPACT !== "noop")
          await connection.sessionUpdate({
            sessionId: String(params.sessionId),
            update: {
              sessionUpdate: "session_info_update",
              _meta: { kiro: { kind: "summarization_completed", summarization: { status: "success" } } },
            },
          })
        return { success: true }
      }
      if (method === "session/set_model") models.set(String(params.sessionId), String(params.modelId))
      return {}
    },
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
      if (text.includes("session-requests")) {
        await say(sessionId, JSON.stringify(requests))
        return { stopReason: "end_turn" }
      }
      if (process.env.FAKE_ACP_ASYNC_COMPACT && text === "/compact") {
        compacting = true
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          await connection.extNotification("_kiro.dev/compaction/status", { sessionId, status: { type: "started" } })
          if (process.env.FAKE_ACP_ASYNC_COMPACT === "hang") return
          await new Promise((resolve) => setTimeout(resolve, 60))
          compacting = false
          await connection.extNotification("_kiro.dev/compaction/status", {
            sessionId,
            status:
              process.env.FAKE_ACP_ASYNC_COMPACT === "fail"
                ? { type: "failed", message: "fixture compaction failed" }
                : { type: "completed" },
          })
        })()
        return { stopReason: "end_turn" }
      }
      if (compacting) throw new Error("A prompt arrived before compaction completed")
      // The host context may ride ahead of it; the call is the last line.
      if (text.includes("invoke:")) {
        const input = JSON.parse(text.slice(text.lastIndexOf("invoke:") + "invoke:".length))
        const toolCallId = "call_invoke"
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: v3 ? `@redsun/${input.name}` : input.name,
            rawInput: v3
              ? { ...input.args, _meta: { _isValid: true, _activePath: [], _completedPaths: [] } }
              : input.args,
            _meta: v3
              ? { kiro: { serverName: "redsun", toolOrigin: "client" } }
              : { mcpToolIdentity: { serverName: "redsun", toolName: input.name } },
          },
        })
        const client = await mcp(sessionId)
        const result = await client?.callTool({ name: input.name, arguments: input.args })
        await client?.close()
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: result?.isError ? "failed" : "completed",
            content: [{ type: "content", content: { type: "text", text: JSON.stringify(result) } }],
          },
        })
        return { stopReason: "end_turn" }
      }
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
      if (text.includes("shell?")) {
        const answer = await connection.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: "call_shell",
            title: "Run command",
            kind: "execute",
            rawInput: { command: "rm -rf build" },
          },
          options: [
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        })
        const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId === "yes"
        await say(sessionId, allowed ? "RAN" : "DENIED")
        return { stopReason: "end_turn" }
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
        process.stderr.write("fake agent: out of credits\n")
        process.exit(3)
      }
      if (text.includes("stubborn")) {
        // An agent that ignores session/cancel and keeps the prompt open.
        await say(sessionId, "working")
        await new Promise((resolve) => setTimeout(resolve, 3_000))
        return { stopReason: "end_turn" }
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
      if (text.includes("plan!")) {
        const entries = (first: "in_progress" | "completed") => [
          { content: "write tests", status: first, priority: "high" as const },
          { content: "ship", status: "pending" as const, priority: "low" as const },
        ]
        await connection.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "plan", entries: entries("in_progress") },
        })
        // An unchanged plan records nothing.
        await connection.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "plan", entries: entries("in_progress") },
        })
        await connection.sessionUpdate({ sessionId, update: { sessionUpdate: "plan", entries: entries("completed") } })
        await say(sessionId, "PLANNED")
        return { stopReason: "end_turn" }
      }
      if (text.includes("model?")) {
        await say(sessionId, `MODEL=${models.get(sessionId) ?? "auto"}`)
        return { stopReason: "end_turn" }
      }
      if (text.includes("tools?")) {
        const client = await mcp(sessionId)
        const listed = client ? (await client.listTools()).tools.map((tool) => tool.name).join(",") : "none"
        await client?.close()
        await say(sessionId, `TOOLS=${listed}`)
        return { stopReason: "end_turn" }
      }
      if (text.includes("hostlate")) {
        // As Kiro sometimes does: the MCP call reaches the host before the agent reports it.
        const args = { todos: [{ content: "ship it", status: "pending" }] }
        const client = await mcp(sessionId)
        const pending = client?.callTool({ name: "todowrite", arguments: args })
        await new Promise((resolve) => setTimeout(resolve, 50))
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call_late",
            title: "Running: @redsun/todowrite",
            rawInput: args,
            _meta: { kiro: { toolName: "todowrite", mcpServerName: "redsun" } },
          },
        })
        const result = await pending
        await client?.close()
        await connection.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId: "call_late", status: "completed" },
        })
        await say(sessionId, result?.isError ? "LATE FAILED" : "LATE DONE")
        return { stopReason: "end_turn" }
      }
      if (text.includes("hostquiet")) {
        // A host tool the agent calls without ever reporting it as a tool call.
        const client = await mcp(sessionId)
        const result = client ? await client.callTool({ name: "todowrite", arguments: { todos: [] } }) : undefined
        await client?.close()
        await say(sessionId, result?.isError ? "QUIET FAILED" : "QUIET DONE")
        return { stopReason: "end_turn" }
      }
      if (text.includes("home?")) {
        const home = process.env.FAKE_ACP_HOME
        const profile = home ? readFileSync(`${home}/agents/redsun.json`, "utf8").trim() : "none"
        await say(sessionId, `HOME=${home} PROFILE=${profile}`)
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
