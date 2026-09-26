export * as AcpKiro from "./kiro.js"

import type { InitializeResponse, NewSessionResponse, SessionUpdate } from "@agentclientprotocol/sdk"

export const COMPACT = "_kiro/session/compact"
export const CURSOR = "kiro-v3:"
export const PROFILE = "redsun"

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** Verified with CLI 2.23.1 / KAS 0.66.8. Check the protocol, rather than guessing from CLI versions. */
export const validate = (response: InitializeResponse) => {
  const methods = record(record(response.agentCapabilities?._meta)?.kiro)?.extensionMethods
  if (!response.agentCapabilities?.mcpCapabilities?.http || !Array.isArray(methods) || !methods.includes(COMPACT))
    throw new Error("Kiro's v3 ACP capabilities are unavailable. Install Kiro CLI 2.23.1 or newer with the v3 engine.")
}

export const metadata = (tools: boolean, cwd: string) => ({
  kiro: {
    modeId: PROFILE,
    isEmptyWorkspace: true,
    customAgents: [
      {
        id: PROFILE,
        description: "Kiro driven by redsun; all tools and project context belong to the host.",
        prompt: `You are working through redsun. Use only the redsun host tools and follow its supplied instructions. The native Kiro workspace is intentionally empty; the actual host working directory is ${JSON.stringify(cwd)}. Host file and shell tools operate in that directory.`,
        tools: tools ? ["@redsun"] : [],
        excludedTools: ["@builtin"],
        includeMcpJson: false,
        includePowers: false,
        resources: [],
        permissions: {
          rules: [
            // V3 re-adds skill disclosure after tool filtering. Policy denial removes it too.
            { capability: "builtin", match: ["*"], effect: "deny" },
            { capability: "mcp", match: ["redsun/*"], effect: tools ? "allow" : "deny" },
          ],
        },
      },
    ],
  },
})

export const validateSession = (response: Omit<NewSessionResponse, "sessionId">) => {
  const mode =
    response.modes?.currentModeId ?? response.configOptions?.find((item) => item.category === "mode")?.currentValue
  if (mode !== PROFILE) throw new Error("Kiro did not select redsun's host-only v3 profile.")
}

export const compacted = (update: SessionUpdate) => {
  const kiro = record(record(update._meta)?.kiro)
  return (
    update.sessionUpdate === "session_info_update" &&
    kiro?.kind === "summarization_completed" &&
    record(kiro.summarization)?.status === "success"
  )
}

/**
 * V3 never sends `usage_update`: it reports context only as a percentage of the active model's
 * window, in `session_info_update` metadata (kind `context_usage`). No ACP field states the window,
 * and its tokens, cache and cost are not exposed at all.
 */
export const contextPercent = (update: SessionUpdate) => {
  if (update.sessionUpdate !== "session_info_update") return undefined
  const kiro = record(record(update._meta)?.kiro)
  if (kiro?.kind !== "context_usage" || typeof kiro.usagePercentage !== "number") return undefined
  return kiro.usagePercentage
}

/** Normalize identified v3 host reports; strip only the known incremental-parser bookkeeping shape. */
export const normalize = (update: SessionUpdate): SessionUpdate => {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return update
  const kiro = record(record(update._meta)?.kiro)
  if (kiro?.serverName !== "redsun" || kiro.toolOrigin !== "client") return update
  const name = update.title?.startsWith("@redsun/") ? update.title.slice("@redsun/".length) : undefined
  const input = record(update.rawInput)
  const bookkeeping = record(input?._meta)
  return {
    ...update,
    ...(name ? { _meta: { ...update._meta, mcpToolIdentity: { serverName: "redsun", toolName: name } } } : {}),
    ...(input &&
    bookkeeping &&
    typeof bookkeeping._isValid === "boolean" &&
    Array.isArray(bookkeeping._activePath) &&
    Array.isArray(bookkeeping._completedPaths)
      ? { rawInput: Object.fromEntries(Object.entries(input).filter(([key]) => key !== "_meta")) }
      : {}),
  }
}

/** Kiro v2 acknowledges /compact before the asynchronous operation finishes. */
export const compactionStatus = (method: string, params: Record<string, unknown>) => {
  if (method !== "_kiro.dev/compaction/status" || typeof params.sessionId !== "string") return undefined
  const status = params.status
  if (!status || typeof status !== "object" || !("type" in status)) return undefined
  if (status.type === "started" || status.type === "completed")
    return { sessionID: params.sessionId, status: status.type } as const
  if (status.type !== "failed") return undefined
  return {
    sessionID: params.sessionId,
    status: "failed" as const,
    error: "message" in status && typeof status.message === "string" ? status.message : "Kiro compaction failed.",
  }
}
