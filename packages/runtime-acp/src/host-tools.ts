export * as AcpHostTools from "./host-tools.js"

import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { DelegatedToolBinding, DelegatedToolResult } from "@opencode/plugin/effect/delegate"
import { DelegateTools } from "@opencode/plugin/effect/delegate-tools"

// The host's own tools, served to an ACP agent as an MCP server on loopback. ACP agents take MCP
// servers by URL at session start, so one server per runtime serves every session, each through
// its own bearer token. A turn binds the host's tool snapshot for its attribution; the agent's
// tool list stays fixed for the life of its session, so a changed catalog relaunches the agent.

type ToolDefinition = DelegatedToolBinding["definitions"][number]

/** The MCP server name the agent sees; agents namespace its tools under it. */
export const SERVER_NAME = "redsun"

/** Host tools offered to every agent; connected MCP tools join only when the host exposes them directly. */
export const NAMES: ReadonlySet<string> = new Set(["subagent", "skill", "todowrite", "worker_model"])

/** Some agents add bookkeeping fields to a tool's input before reporting it. */
const BOOKKEEPING = ["__tool_use_purpose"]

/** Code Mode's tool; offered only with its catalog, which the host context delivers. */
export const CODE_MODE = "execute"

/**
 * The host tools an agent session gets: the host's extras beside the agent's native tools, or
 * everything a native redsun agent has. Code Mode only ever comes with its catalog.
 */
export const select = (binding: DelegatedToolBinding, mode: "extras" | "all" = "extras") =>
  binding.definitions.filter((item) =>
    item.name === CODE_MODE
      ? !!binding.codeMode
      : mode === "all" || NAMES.has(item.name) || binding.direct.has(item.name),
  )

/** The agent lists tools once per session; a different key needs a new session. */
export const catalogKey = DelegateTools.catalogKey

export const cleanInput = (input: unknown) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  return Object.fromEntries(Object.entries(input).filter(([key]) => !BOOKKEEPING.includes(key)))
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * The host tool a reported tool call runs, when the agent says which MCP server it belongs to. ACP
 * carries no standard field for this; Kiro reports `_meta.kiro.{mcpServerName,toolName}`.
 */
export const identify = (meta: unknown): string | undefined => {
  const kiro = record(record(meta)?.kiro)
  const identity = record(record(meta)?.mcpToolIdentity)
  const server = kiro?.mcpServerName ?? identity?.serverName
  const tool = kiro?.toolName ?? identity?.toolName
  return server === SERVER_NAME && typeof tool === "string" ? tool : undefined
}

interface Reported {
  readonly id: string
  readonly name: string
  readonly input: string
}

interface Waiting {
  readonly name: string
  readonly input: string
  readonly resolve: (id: string) => void
}

/**
 * How long an MCP call waits for the agent's report of it. Agents report a tool call and call the
 * MCP server in either order (Kiro does both), so an unmatched call waits briefly for its report.
 */
export const REPORT_WAIT_MS = 1_000

/** The best match for a call among reports or waiting calls: same name and input, else same name. */
const match = <T extends { readonly name: string; readonly input: string }>(
  items: readonly T[],
  name: string,
  input: string,
) => {
  const exact = items.findIndex((item) => item.name === name && item.input === input)
  return exact >= 0 ? exact : items.findIndex((item) => item.name === name)
}

/** One agent session's view of the host tools. */
export class Slot {
  readonly token = randomBytes(24).toString("base64url")
  private binding?: { readonly tools: DelegatedToolBinding; readonly messageID: string }
  /** Host tool calls the agent reported and has not yet executed, oldest first. */
  private readonly reported: Reported[] = []
  /** MCP calls that arrived before the agent reported them, oldest first. */
  private readonly waiting: Waiting[] = []
  /** Every host tool call id the agent reported, for permission requests. */
  private readonly known = new Set<string>()
  private readonly results = new Map<string, DelegatedToolResult>()
  private calls = 0

  /** Fixed for the agent session: the agent lists them once, when the session starts. */
  constructor(
    readonly catalog: string,
    readonly definitions: ReadonlyArray<ToolDefinition>,
  ) {}

  bind(tools: DelegatedToolBinding, messageID: string) {
    this.binding = { tools, messageID }
  }

  unbind() {
    this.binding = undefined
    this.reported.length = 0
  }

  /** Records a tool call the agent reported; returns the host tool's name when it is one. */
  report(update: SessionUpdate): string | undefined {
    if (update.sessionUpdate !== "tool_call") return undefined
    const name = identify(update._meta)
    if (!name) return undefined
    this.known.add(update.toolCallId)
    const input = JSON.stringify(cleanInput(update.rawInput ?? {}))
    const waiting = match(this.waiting, name, input)
    if (waiting >= 0) this.waiting.splice(waiting, 1)[0]!.resolve(update.toolCallId)
    else this.reported.push({ id: update.toolCallId, name, input })
    return name
  }

  owns(toolCallID: string) {
    return this.known.has(toolCallID)
  }

  /** The host result for a reported call, once; its metadata renders the host's tool row. */
  take(toolCallID: string) {
    const result = this.results.get(toolCallID)
    this.results.delete(toolCallID)
    return result
  }

  /**
   * Matches an MCP call to the agent's report of it, by name and input, so the host executes it
   * under the agent's own call id. A call the agent has not reported yet waits for the report; one
   * it never reports gets an id of its own.
   */
  private claim(name: string, args: unknown, messageID: string, signal: AbortSignal): Promise<string> {
    const input = JSON.stringify(cleanInput(args))
    const index = match(this.reported, name, input)
    if (index >= 0) return Promise.resolve(this.reported.splice(index, 1)[0]!.id)
    const own = `acp-mcp-${messageID}-${++this.calls}`
    return new Promise((resolve) => {
      const giveUp = () => {
        const at = this.waiting.indexOf(waiting)
        if (at >= 0) this.waiting.splice(at, 1)
        resolve(own)
      }
      const timer = setTimeout(giveUp, REPORT_WAIT_MS)
      const waiting: Waiting = {
        name,
        input,
        resolve: (id) => {
          clearTimeout(timer)
          signal.removeEventListener("abort", giveUp)
          resolve(id)
        },
      }
      this.waiting.push(waiting)
      signal.addEventListener("abort", giveUp, { once: true })
    })
  }

  async call(name: string, args: unknown, signal: AbortSignal) {
    const bound = this.binding
    if (!bound) throw new Error("Host tools are not bound to an active turn.")
    if (!this.definitions.some((item) => item.name === name))
      throw new Error(`Tool is not available for this request: ${name}`)
    const callID = await this.claim(name, args, bound.messageID, signal)
    const result = await bound.tools.execute({
      name,
      args,
      callID,
      allowed: new Set(this.definitions.map((item) => item.name)),
      signal,
    })
    this.results.set(callID, result)
    return result
  }
}

export const resultText = (result: DelegatedToolResult) =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")

const failure = (error: unknown) => ({
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  isError: true,
})

const matches = (header: string | undefined, token: string) => {
  const given = Buffer.from(header ?? "")
  const wanted = Buffer.from(`Bearer ${token}`)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

/** A loopback MCP endpoint shared by one runtime's sessions. */
export class Endpoint {
  private readonly slots = new Map<string, Slot>()
  private started?: Promise<{ readonly server: HttpServer; readonly url: string }>

  attach(slot: Slot) {
    this.slots.set(slot.token, slot)
  }

  detach(slot: Slot) {
    this.slots.delete(slot.token)
  }

  /** The ACP `mcpServers` entry for a slot. */
  async entry(slot: Slot) {
    const { url } = await this.start()
    return {
      type: "http" as const,
      name: SERVER_NAME,
      url,
      headers: [{ name: "Authorization", value: `Bearer ${slot.token}` }],
    }
  }

  private start() {
    this.started ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => void this.handle(request, response))
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") return reject(new Error("Host tool server has no port."))
        resolve({ server, url: `http://127.0.0.1:${address.port}/mcp` })
      })
    })
    return this.started
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const slot = [...this.slots.values()].find((item) => matches(request.headers.authorization, item.token))
    if (!slot) {
      response.writeHead(401).end()
      return
    }
    const server = new Server({ name: SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: slot.definitions.map((item) => ({
        name: item.name,
        description: item.description,
        inputSchema: item.inputSchema as { type: "object"; properties?: Record<string, unknown> },
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
      try {
        const result = await slot.call(call.params.name, call.params.arguments ?? {}, extra.signal)
        if (extra.signal.aborted) throw new Error("Host tool call was cancelled.")
        return { content: DelegateTools.mcpContent(result) }
      } catch (error) {
        if (extra.signal.aborted) throw error
        return failure(error)
      }
    })
    // Stateless: each request carries its own transport, so no MCP session outlives an agent.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    response.on("close", () => void transport.close())
    await server.connect(transport)
    await transport.handleRequest(request, response)
  }

  stop() {
    void this.started?.then(({ server }) => server.close())
    this.started = undefined
    this.slots.clear()
  }
}
