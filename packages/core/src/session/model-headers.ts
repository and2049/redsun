export * as SessionModelHeaders from "./model-headers.js"

import { App } from "../app.js"
import { SessionSchema } from "./schema.js"

export const INTERNAL_HEADER = "x-opencode-internal"

export const internal = { [INTERNAL_HEADER]: "1" } as const

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
