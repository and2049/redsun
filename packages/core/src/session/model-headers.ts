export * as SessionModelHeaders from "./model-headers.js"

// REDSUN: marker header for one-shot requests (title, compaction) so a delegated
// provider never treats them as interactive turns. The session header set itself
// lives in model-request.ts (upstream inlined it there); this module is only the
// internal marker and its detector.
export const INTERNAL_HEADER = "x-opencode-internal"

export const internal = { [INTERNAL_HEADER]: "1" } as const

export const isInternal = (headers: Record<string, string | undefined> | undefined) => {
  if (!headers) return false
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === INTERNAL_HEADER && value) return true
  return false
}
