export * as AcpKiro from "./kiro.js"

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
