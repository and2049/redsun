// A scripted ACP agent over stdio. The prompt text picks the behaviour.
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type Agent } from "@agentclientprotocol/sdk"

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
)

let sessions = 0
const modes = new Map<string, string>()
const cancelled = new Set<string>()
const received: string[] = []

new AgentSideConnection((connection) => {
  const say = (sessionId: string, text: string) =>
    connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    })
  const agent: Agent = {
    initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }),
    newSession: async () => {
      const sessionId = `acp_${++sessions}`
      modes.set(sessionId, "default")
      return {
        sessionId,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "trust", name: "Trust all tools" },
          ],
        },
      }
    },
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
