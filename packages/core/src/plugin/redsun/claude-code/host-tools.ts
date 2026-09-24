export * as ClaudeCodeHostTools from "./host-tools.js"

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { ToolDefinition } from "@opencode/ai"
import { Effect } from "effect"
import type { Agent } from "../../../agent.js"
import type { SessionMessage } from "../../../session/message.js"
import type { SessionSchema } from "../../../session/schema.js"
import type { Tool } from "../../../tool.js"
import { McpTool } from "../../../tool/mcp.js"
import type { Mcp } from "../../../mcp/index.js"

export const NAMES = ["subagent", "skill", "todowrite", "worker_model", "execute"] as const
export const MCP_NAMES = NAMES.map((name) => `mcp__redsun__${name}`)

/** Exact effective names of connected direct MCP registrations, not a name-prefix heuristic. */
export const directNames = (discovered: readonly Mcp.Tool[]): ReadonlySet<string> =>
  new Set(discovered.filter((tool) => tool.codemode === false).map((tool) => McpTool.name(tool.server, tool.name)))

/** Keep selection at the canonical request boundary; neither arbitrary host nor Code Mode leaf tools are direct. */
export const select = (input: {
  readonly definitions: HostExecution["definitions"]
  readonly available: readonly string[]
  readonly direct: ReadonlySet<string>
  readonly behavior?: "redsun" | "native"
}) => {
  const available = new Set(input.available)
  return input.definitions.filter(
    (item) =>
      available.has(item.name) &&
      (input.behavior === "native"
        ? item.name === "subagent"
        : NAMES.includes(item.name as (typeof NAMES)[number]) || input.direct.has(item.name)),
  )
}

/** The CLI caches tools/list; direct tool descriptions and schemas require rediscovery. */
export const discoveryKey = (definitions: HostExecution["definitions"]) =>
  JSON.stringify(
    definitions
      .map((item) => [item.name, item.inputSchema, item.description])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  )

/**
 * A turn captures one canonical Tool.Snapshot and its attribution. The caller
 * must resolve session/agent/message IDs at the turn boundary, not by querying
 * the latest session message during an asynchronous MCP callback. Execute via
 * snapshot.execute with a stable call ID and run the Effect with signal-based
 * interruption. Never call the underlying tool registration directly.
 */
export interface HostExecution {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly allowed?: ReadonlySet<string>
  readonly execute: (input: {
    readonly name: string
    readonly args: unknown
    readonly requestId: string
    /** CLI-provided native tool-use ID, when available (not the MCP request ID). */
    readonly nativeToolUseID?: string
    readonly signal: AbortSignal
  }) => Promise<Tool.NormalizedResult>
  /**
   * Called before a result is returned to Claude. Correlate by nativeToolUseID
   * (scoped to the native session), never by requestId or argument equality.
   * The CLI's PostToolUse tool_response is only the content array: MCP _meta
   * does not survive there. Clear per-turn entries after translated settlement.
   */
  readonly onResult?: (input: {
    name: string
    requestId: string
    nativeToolUseID?: string
    result: Tool.NormalizedResult
  }) => void
}

export const fromSnapshot = (input: {
  readonly snapshot: Tool.Snapshot
  readonly sessionID: SessionSchema.ID
  readonly agent: Agent.ID
  readonly messageID: SessionMessage.ID
  readonly onResult?: HostExecution["onResult"]
  readonly allowed?: ReadonlySet<string>
}): HostExecution => ({
  definitions: input.snapshot.definitions,
  allowed: input.allowed,
  onResult: input.onResult,
  execute: ({ name, args, requestId, nativeToolUseID, signal }) =>
    Effect.runPromise(
      input.snapshot.execute({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.messageID,
        call: {
          type: "tool-call",
          id: nativeToolUseID ?? `claude-code-mcp-${input.messageID}-${requestId}`,
          name,
          input: args,
        } as never,
        ...(input.allowed === undefined
          ? {}
          : {
              definitions: new Map(
                input.snapshot.definitions
                  .filter((item) => input.allowed?.has(item.name))
                  .map((item) => [item.name, item]),
              ),
            }),
      }),
      { signal },
    ),
})

const errorResult = (error: unknown) => ({
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  isError: true,
})

/**
 * Register raw JSON Schemas at the MCP protocol boundary. The SDK's `tool()`
 * helper accepts only Zod raw shapes and would round-trip/relax canonical
 * Effect-derived JSON schemas. The host snapshot remains the input validator.
 *
 * For a persistent SDK process, pass a getter returning the current turn's
 * HostExecution (or undefined while unbound). The getter is evaluated once per
 * call, before execution, so a subsequent turn cannot change an in-flight
 * call's snapshot or attribution. Bind the turn before sending it to the SDK
 * and clear the binding after it settles; do not overlap turns on one server.
 * Bind before initial SDK tool discovery as well: an unbound tools/list is
 * empty, and the SDK may cache that catalog. If availability changes after
 * discovery, the orchestrator must refresh/recreate the SDK MCP registration.
 * A direct HostExecution remains supported for one-turn callers.
 */
export const makeServer = (
  binding: HostExecution | (() => HostExecution | undefined),
): McpSdkServerConfigWithInstance => {
  const current = typeof binding === "function" ? binding : () => binding
  const definitions = (host: HostExecution | undefined) =>
    new Map(
      host?.definitions
        .filter((item) => host.allowed?.has(item.name) ?? NAMES.includes(item.name as (typeof NAMES)[number]))
        .map((item) => [item.name, item]) ?? [],
    )
  const server = createSdkMcpServer({ name: "redsun", tools: [] })
  server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...definitions(current()).values()].map((item) => ({
      name: item.name,
      description: item.description,
      inputSchema: item.inputSchema as { type: "object"; properties?: Record<string, unknown> },
    })),
  }))
  server.instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const host = current()
    const name = request.params.name
    // The installed CLI supplies its native tool-use ID in MCP request metadata.
    // MCP JSON-RPC requestId is a different ID and may be reused across turns.
    const nativeToolUseID = extra._meta?.["claudecode/toolUseId"]
    const nativeID = typeof nativeToolUseID === "string" && nativeToolUseID ? nativeToolUseID : undefined
    if (!host) return errorResult("Host tools are not bound to an active turn.")
    if (!definitions(host).has(name)) return errorResult(`Tool is not available for this request: ${name}`)
    try {
      const result = await host.execute({
        name,
        args: request.params.arguments ?? {},
        requestId: String(extra.requestId),
        nativeToolUseID: nativeID,
        signal: extra.signal,
      })
      if (extra.signal.aborted) throw new Error("Host tool call was cancelled.")
      host.onResult?.({ name, requestId: String(extra.requestId), nativeToolUseID: nativeID, result })
      return {
        content: result.content.map((part) =>
          part.type === "text"
            ? { type: "text" as const, text: part.text }
            : part.type === "file" && part.mime.startsWith("image/") && part.uri.startsWith(`data:${part.mime};base64,`)
              ? {
                  type: "image" as const,
                  data: part.uri.slice(`data:${part.mime};base64,`.length),
                  mimeType: part.mime,
                }
              : { type: "text" as const, text: JSON.stringify(part) },
        ),
        // Do not set structuredContent: the SDK treats text content as a
        // duplicate when it is present, dropping canonical skill instructions.
        ...(result.metadata === undefined ? {} : { _meta: { "redsun/metadata": result.metadata } }),
      }
    } catch (error) {
      if (extra.signal.aborted) throw error
      return errorResult(error)
    }
  })
  return server
}
