export * as SessionModelHeaders from "./model-headers.js"

import { App } from "../app.js"
import { SessionSchema } from "./schema.js"

// REDSUN: marks a request redsun makes on its own behalf rather than one the
// user is having a conversation in -- a title, a summary, a compaction.
//
// The delegated Claude Code provider has to tell the two apart: an interactive
// turn goes to the session's live CLI process, while an internal one must run
// one-shot in a throwaway process. Otherwise "generate a title for this
// conversation" is delivered *into* the user's Claude Code conversation,
// consuming a turn and moving its resume cursor. V1 had `input.internal` on the
// request itself; v2's plugin sees only a LanguageModelV3 call, so the flag
// travels on the wire.
export const INTERNAL_HEADER = "x-opencode-internal"

/** Spread alongside `make` at a call site that is not a user turn. */
export const internal = { [INTERNAL_HEADER]: "1" } as const

/** True when the request carried the internal marker. */
export const isInternal = (headers: Record<string, string | undefined> | undefined) => {
  if (!headers) return false
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === INTERNAL_HEADER && value) return true
  return false
}

export const make = (session: Pick<SessionSchema.Info, "id" | "parentID" | "projectID">, app: App.Info) => ({
  "x-session-affinity": session.id,
  "X-Session-Id": session.id,
  ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
  "User-Agent": App.useragent(app),
  "x-opencode-project": session.projectID,
  "x-opencode-session": session.id,
  "x-opencode-client": app.name,
})
