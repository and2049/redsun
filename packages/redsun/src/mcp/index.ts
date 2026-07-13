import type { Tool } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { NamedError } from "@redsun/util/error"
import z from "zod/v4"
import { Instance } from "../project/instance"
import { Installation } from "../installation"
import { withTimeout } from "@/util/timeout"
import { McpOAuthPendingProvider, McpOAuthProvider } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"
import type { Provider } from "../provider/provider"
import { convertMcpTool } from "./tool-convert"

export namespace MCP {
  const log = Log.create({ service: "mcp" })

  export const ToolsChanged = BusEvent.define(
    "mcp.tools.changed",
    z.object({
      server: z.string(),
    }),
  )

  export const Failed = NamedError.create(
    "MCPFailed",
    z.object({
      name: z.string(),
    }),
  )

  type MCPClient = Client

  export const Status = z
    .discriminatedUnion("status", [
      z
        .object({
          status: z.literal("connected"),
        })
        .meta({
          ref: "MCPStatusConnected",
        }),
      z
        .object({
          status: z.literal("disabled"),
        })
        .meta({
          ref: "MCPStatusDisabled",
        }),
      z
        .object({
          status: z.literal("failed"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusFailed",
        }),
      z
        .object({
          status: z.literal("needs_auth"),
        })
        .meta({
          ref: "MCPStatusNeedsAuth",
        }),
      z
        .object({
          status: z.literal("needs_client_registration"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusNeedsClientRegistration",
        }),
    ])
    .meta({
      ref: "MCPStatus",
    })
  export type Status = z.infer<typeof Status>

  // Register notification handlers for MCP client
  function registerNotificationHandlers(client: MCPClient, serverName: string) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      log.info("tools list changed notification received", { server: serverName })
      Bus.publish(ToolsChanged, { server: serverName })
    })
  }

  // Store transports for OAuth servers to allow finishing auth
  type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
  const pendingOAuthTransports = new Map<string, { transport: TransportWithAuth; provider?: McpOAuthPendingProvider }>()
  const MAX_LIST_PAGES = 20

  export async function paginate<T>(
    first: (cursor?: string) => Promise<{ nextCursor?: string; tools?: T[]; resources?: T[]; resourceTemplates?: T[] }>,
    pick: (page: { tools?: T[]; resources?: T[]; resourceTemplates?: T[] }) => T[] | undefined,
  ) {
    const result: T[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await first(cursor)
      result.push(...(pick(res) ?? []))
      if (!res.nextCursor) return result
      cursor = res.nextCursor
    }
    throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
  }

  const resourceKey = (clientName: string, id: string) => `${clientName.replaceAll("%", "%25").replaceAll(":", "%3A")}:${id}`

  const state = Instance.state(
    async () => {
      const cfg = await Config.get()
      const config = cfg.mcp ?? {}
      const clients: Record<string, MCPClient> = {}
      const status: Record<string, Status> = {}

      await Promise.all(
        Object.entries(config).map(async ([key, mcp]) => {
          // If disabled by config, mark as disabled without trying to connect
          if (mcp.enabled === false) {
            status[key] = { status: "disabled" }
            return
          }

          const result = await create(key, mcp).catch(() => undefined)
          if (!result) return

          status[key] = result.status

          if (result.mcpClient) {
            clients[key] = result.mcpClient
          }
        }),
      )
      return {
        status,
        clients,
      }
    },
    async (state) => {
      await Promise.all(
        Object.values(state.clients).map((client) =>
          client.close().catch((error) => {
            log.error("Failed to close MCP client", {
              error,
            })
          }),
        ),
      )
      pendingOAuthTransports.clear()
    },
  )

  export async function add(name: string, mcp: Config.Mcp) {
    const s = await state()
    const result = await create(name, mcp)
    if (!result) {
      const status = {
        status: "failed" as const,
        error: "unknown error",
      }
      s.status[name] = status
      return {
        status,
      }
    }
    if (!result.mcpClient) {
      s.status[name] = result.status
      return {
        status: s.status,
      }
    }
    s.clients[name] = result.mcpClient
    s.status[name] = result.status

    return {
      status: s.status,
    }
  }

  async function create(key: string, mcp: Config.Mcp) {
    if (mcp.enabled === false) {
      log.info("mcp server disabled", { key })
      return {
        mcpClient: undefined,
        status: { status: "disabled" as const },
      }
    }
    if (mcp.type === "local" && (await Config.isProjectMcp(key))) {
      const { ToolRegistry } = await import("../tool/registry")
      if (!(await ToolRegistry.getRunner()).projectTrusted) {
        log.warn("skipping untrusted project local MCP server", { key })
        return {
          mcpClient: undefined,
          status: { status: "disabled" as const },
        }
      }
    }
    log.info("found", { key, type: mcp.type })
    let mcpClient: MCPClient | undefined
    let status: Status | undefined = undefined

    if (mcp.type === "remote") {
      // OAuth is enabled by default for remote servers unless explicitly disabled with oauth: false
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
              // Store the URL - actual browser opening is handled by startAuth
            },
          },
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      let lastError: Error | undefined
      for (const { name, transport } of transports) {
        try {
          const client = new Client({
            name: "redsun",
            version: Installation.VERSION,
          })
          await client.connect(transport)
          registerNotificationHandlers(client, key)
          mcpClient = client
          log.info("connected", { key, transport: name })
          status = { status: "connected" }
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))

          // Handle OAuth-specific errors
          if (error instanceof UnauthorizedError) {
            log.info("mcp server requires authentication", { key, transport: name })

            // Check if this is a "needs registration" error
            if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
              status = {
                status: "needs_client_registration" as const,
                error: "Server does not support dynamic client registration. Please provide clientId in config.",
              }
              // Show toast for needs_client_registration
              Bus.publish(TuiEvent.ToastShow, {
                title: "MCP Authentication Required",
                message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                variant: "warning",
                duration: 8000,
              }).catch((e) => log.debug("failed to show toast", { error: e }))
            } else {
              // Store transport for later finishAuth call
              pendingOAuthTransports.set(key, { transport })
              status = { status: "needs_auth" as const }
              // Show toast for needs_auth
              Bus.publish(TuiEvent.ToastShow, {
                title: "MCP Authentication Required",
                message: `Server "${key}" requires authentication. Run: redsun mcp auth ${key}`,
                variant: "warning",
                duration: 8000,
              }).catch((e) => log.debug("failed to show toast", { error: e }))
            }
            break
          }

          log.debug("transport connection failed", {
            key,
            transport: name,
            url: mcp.url,
            error: lastError.message,
          })
          status = {
            status: "failed" as const,
            error: lastError.message,
          }
        }
      }
    }

    if (mcp.type === "local") {
      const [cmd, ...args] = mcp.command
      const transport = new StdioClientTransport({
        stderr: "ignore",
        command: cmd,
        args,
        env: {
          ...process.env,
          ...(cmd === "redsun" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })

      try {
        const client = new Client({
          name: "redsun",
          version: Installation.VERSION,
        })
        await client.connect(transport)
        registerNotificationHandlers(client, key)
        mcpClient = client
        status = {
          status: "connected",
        }
      } catch (error) {
        log.error("local mcp startup failed", {
          key,
          command: mcp.command,
          error: error instanceof Error ? error.message : String(error),
        })
        status = {
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    if (!status) {
      status = {
        status: "failed" as const,
        error: "Unknown error",
      }
    }

    if (!mcpClient) {
      return {
        mcpClient: undefined,
        status,
      }
    }

    const result = await withTimeout(
      paginate<any>((cursor) => (mcpClient as any).listTools(cursor ? { cursor } : undefined), (page) => page.tools),
      mcp.timeout ?? 5000,
    ).catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return undefined
    })
    if (!result) {
      await mcpClient.close().catch((error) => {
        log.error("Failed to close MCP client", {
          error,
        })
      })
      status = {
        status: "failed",
        error: "Failed to get tools",
      }
      return {
        mcpClient: undefined,
        status: {
          status: "failed" as const,
          error: "Failed to get tools",
        },
      }
    }

    log.info("create() successfully created client", { key, toolCount: result.length })
    return {
      mcpClient,
      status,
    }
  }

  export async function status() {
    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const result: Record<string, Status> = {}

    // Include all MCPs from config, not just connected ones
    for (const key of Object.keys(config)) {
      result[key] = s.status[key] ?? { status: "disabled" }
    }

    return result
  }

  export async function clients() {
    return state().then((state) => state.clients)
  }

  export async function connect(name: string) {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const mcp = config[name]
    if (!mcp) {
      log.error("MCP config not found", { name })
      return
    }

    const result = await create(name, { ...mcp, enabled: true })

    if (!result) {
      const s = await state()
      s.status[name] = {
        status: "failed",
        error: "Unknown error during connection",
      }
      return
    }

    const s = await state()
    s.status[name] = result.status
    if (result.mcpClient) {
      s.clients[name] = result.mcpClient
    }
  }

  export async function disconnect(name: string) {
    const s = await state()
    const client = s.clients[name]
    if (client) {
      await client.close().catch((error) => {
        log.error("Failed to close MCP client", { name, error })
      })
      delete s.clients[name]
    }
    s.status[name] = { status: "disabled" }
  }

  export async function tools(model: Provider.Model) {
    const result: Record<string, Tool> = {}
    const s = await state()
    const clientsSnapshot = await clients()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}

    for (const [clientName, client] of Object.entries(clientsSnapshot)) {
      // Only include tools from connected MCPs (skip disabled ones)
      if (s.status[clientName]?.status !== "connected") {
        continue
      }

      const toolsResult = await paginate<any>(
        (cursor) => (client as any).listTools(cursor ? { cursor } : undefined),
        (page) => page.tools,
      ).catch((e) => {
        log.error("failed to get tools", { clientName, error: e.message })
        const failedStatus = {
          status: "failed" as const,
          error: e instanceof Error ? e.message : String(e),
        }
        s.status[clientName] = failedStatus
        delete s.clients[clientName]
        return undefined
      })
      if (!toolsResult) {
        continue
      }
      for (const mcpTool of toolsResult) {
        const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
        const sanitizedToolName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
        result[sanitizedClientName + "_" + sanitizedToolName] = convertMcpTool(
          mcpTool,
          client,
          model,
          config[clientName]?.timeout,
        )
      }
    }
    return result
  }

  export interface Resource {
    uri: string
    name: string
    description?: string
    mimeType?: string
    client: string
  }

  export interface ResourceTemplate {
    uriTemplate: string
    name: string
    description?: string
    mimeType?: string
    client: string
  }

  export interface McpInstructions {
    name: string
    instructions: string
    tools: string[]
  }

  export async function resources(clientName?: string): Promise<Record<string, Resource>> {
    const s = await state()
    const cfg = await Config.get()
    const result: Record<string, Resource> = {}
    for (const [name, client] of Object.entries(s.clients)) {
      if (s.status[name]?.status !== "connected") continue
      if (clientName && name !== clientName) continue
      if (!client.getServerCapabilities()?.resources) continue
      try {
        const timeout = cfg.mcp?.[name]?.timeout ?? 5000
        const resources = await withTimeout(
          paginate<any>((cursor) => (client as any).listResources(cursor ? { cursor } : undefined), (page) => page.resources),
          timeout,
        )
        for (const resource of resources) {
          result[resourceKey(name, resource.uri)] = { ...resource, client: name }
        }
      } catch (e) {
        log.error("failed to list resources", { clientName: name, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return result
  }

  export async function resourceTemplates(clientName?: string): Promise<Record<string, ResourceTemplate>> {
    const s = await state()
    const cfg = await Config.get()
    const result: Record<string, ResourceTemplate> = {}
    for (const [name, client] of Object.entries(s.clients)) {
      if (s.status[name]?.status !== "connected") continue
      if (clientName && name !== clientName) continue
      if (!client.getServerCapabilities()?.resources) continue
      try {
        const timeout = cfg.mcp?.[name]?.timeout ?? 5000
        const templates = await withTimeout(
          paginate<any>(
            (cursor) => (client as any).listResourceTemplates(cursor ? { cursor } : undefined),
            (page) => page.resourceTemplates,
          ),
          timeout,
        )
        for (const template of templates) {
          result[resourceKey(name, template.uriTemplate)] = { ...template, client: name }
        }
      } catch (e) {
        log.error("failed to list resource templates", { clientName: name, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return result
  }

  export async function readResource(server: string, uri: string): Promise<{ contents: any[] } | undefined> {
    const s = await state()
    const client = s.clients[server]
    if (!client) {
      log.warn("client not found for readResource", { server })
      return undefined
    }
    const cfg = await Config.get()
    const timeout = cfg.mcp?.[server]?.timeout ?? 5000
    try {
      const result = await withTimeout(client.readResource({ uri }), timeout)
      return { contents: Array.isArray(result.contents) ? result.contents : [result.contents] }
    } catch (e) {
      log.error("failed to read resource", { server, uri, error: e instanceof Error ? e.message : String(e) })
      return undefined
    }
  }

  export async function instructions(): Promise<McpInstructions[]> {
    const s = await state()
    const result: McpInstructions[] = []
    for (const [name, client] of Object.entries(s.clients)) {
      if (s.status[name]?.status !== "connected") continue
      const instructionsText = (client as any).getInstructions?.()?.trim()
      if (!instructionsText) continue
      let tools: string[] = []
      try {
        const toolsResult = await paginate<any>(
          (cursor) => (client as any).listTools(cursor ? { cursor } : undefined),
          (page) => page.tools,
        )
        const sanitizedClientName = name.replace(/[^a-zA-Z0-9_-]/g, "_")
        tools = toolsResult.map((t) => `${sanitizedClientName}_${t.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`)
      } catch {}
      result.push({ name, instructions: instructionsText, tools })
    }
    return result
  }

  /**
   * Start OAuth authentication flow for an MCP server.
   * Returns the authorization URL that should be opened in a browser.
   */
  export async function startAuth(mcpName: string): Promise<{ authorizationUrl: string }> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]

    if (!mcpConfig) {
      throw new Error(`MCP server not found: ${mcpName}`)
    }

    if (mcpConfig.type !== "remote") {
      throw new Error(`MCP server ${mcpName} is not a remote server`)
    }

    if (mcpConfig.oauth === false) {
      throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
    }

    // Start the callback server
    await McpOAuthCallback.ensureRunning()

    // Generate and store a cryptographically secure state parameter BEFORE creating the provider
    // The SDK will call provider.state() to read this value
    const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    await McpAuth.updateOAuthState(mcpName, oauthState)

    // Create a new auth provider for this flow
    // OAuth config is optional - if not provided, we'll use auto-discovery
    const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined
    let capturedUrl: URL | undefined
    const authProvider = new McpOAuthPendingProvider(
      mcpName,
      mcpConfig.url,
      {
        clientId: oauthConfig?.clientId,
        clientSecret: oauthConfig?.clientSecret,
        scope: oauthConfig?.scope,
      },
      {
        onRedirect: async (url) => {
          capturedUrl = url
        },
      },
    )

    // Create transport with auth provider
    const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), {
      authProvider,
      requestInit: mcpConfig.headers ? { headers: mcpConfig.headers } : undefined,
    })

    // Try to connect - this will trigger the OAuth flow
    try {
      const client = new Client({
        name: "redsun",
        version: Installation.VERSION,
      })
      await client.connect(transport)
      await authProvider.commit()
      // If we get here, we're already authenticated
      return { authorizationUrl: "" }
    } catch (error) {
      if (error instanceof UnauthorizedError && capturedUrl) {
        // Store transport for finishAuth
        pendingOAuthTransports.set(mcpName, { transport, provider: authProvider })
        return { authorizationUrl: capturedUrl.toString() }
      }
      throw error
    }
  }

  /**
   * Complete OAuth authentication after user authorizes in browser.
   * Opens the browser and waits for callback.
   */
  export async function authenticate(mcpName: string): Promise<Status> {
    const { authorizationUrl } = await startAuth(mcpName)

    if (!authorizationUrl) {
      // Already authenticated
      const s = await state()
      return s.status[mcpName] ?? { status: "connected" }
    }

    // Get the state that was already generated and stored in startAuth()
    const oauthState = await McpAuth.getOAuthState(mcpName)
    if (!oauthState) {
      throw new Error("OAuth state not found - this should not happen")
    }

    // The SDK has already added the state parameter to the authorization URL
    // We just need to open the browser
    log.info("opening browser for oauth", { mcpName, url: authorizationUrl, state: oauthState })
    await open(authorizationUrl)

    // Wait for callback using the OAuth state parameter
    const code = await McpOAuthCallback.waitForCallback(oauthState, mcpName)

    // Validate and clear the state
    const storedState = await McpAuth.getOAuthState(mcpName)
    if (storedState !== oauthState) {
      await McpAuth.clearOAuthState(mcpName)
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }

    await McpAuth.clearOAuthState(mcpName)

    // Finish auth
    return finishAuth(mcpName, code)
  }

  /**
   * Complete OAuth authentication with the authorization code.
   */
  export async function finishAuth(mcpName: string, authorizationCode: string): Promise<Status> {
    const pending = pendingOAuthTransports.get(mcpName)

    if (!pending) {
      throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)
    }

    try {
      // Call finishAuth on the transport
      await pending.transport.finishAuth(authorizationCode)
      await pending.provider?.commit()

      // Clear the code verifier after successful auth
      await McpAuth.clearCodeVerifier(mcpName)

      // Now try to reconnect
      const cfg = await Config.get()
      const mcpConfig = cfg.mcp?.[mcpName]

      if (!mcpConfig) {
        throw new Error(`MCP server not found: ${mcpName}`)
      }

      // Re-add the MCP server to establish connection
      pendingOAuthTransports.delete(mcpName)
      const result = await add(mcpName, { ...mcpConfig, enabled: true })

      const statusRecord = result.status as Record<string, Status>
      return statusRecord[mcpName] ?? { status: "failed", error: "Unknown error after auth" }
    } catch (error) {
      log.error("failed to finish oauth", { mcpName, error })
      return {
        status: "failed",
        error: `OAuth completion failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * Remove OAuth credentials for an MCP server.
   */
  export async function removeAuth(mcpName: string): Promise<void> {
    await McpAuth.remove(mcpName)
    McpOAuthCallback.cancelPending(mcpName)
    pendingOAuthTransports.delete(mcpName)
    await McpAuth.clearOAuthState(mcpName)
    log.info("removed oauth credentials", { mcpName })
  }

  /**
   * Check if an MCP server supports OAuth (remote servers support OAuth by default unless explicitly disabled).
   */
  export async function supportsOAuth(mcpName: string): Promise<boolean> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]
    return mcpConfig?.type === "remote" && mcpConfig.oauth !== false
  }

  /**
   * Check if an MCP server has stored OAuth tokens.
   */
  export async function hasStoredTokens(mcpName: string): Promise<boolean> {
    const entry = await McpAuth.get(mcpName)
    return !!entry?.tokens
  }

  export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

  /**
   * Get the authentication status for an MCP server.
   */
  export async function getAuthStatus(mcpName: string): Promise<AuthStatus> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]
    if (!mcpConfig || mcpConfig.type !== "remote") return "not_authenticated"
    const entry = await McpAuth.getForUrl(mcpName, mcpConfig.url)
    if (!entry?.tokens) return "not_authenticated"
    return entry.tokens.expiresAt && entry.tokens.expiresAt < Date.now() / 1000 ? "expired" : "authenticated"
  }
}
