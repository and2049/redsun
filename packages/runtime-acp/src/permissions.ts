export * as AcpPermissions from "./permissions.js"

import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk"
import type { DelegatedPermissionCheck } from "@opencode/plugin/effect/delegate"

/** The host permission action for an ACP tool kind; unknown kinds use their own action. */
export const action = (kind: string | null | undefined) => {
  switch (kind) {
    case "edit":
    case "delete":
    case "move":
      return "edit"
    case "execute":
      return "shell"
    case "read":
      return "read"
    case "search":
      return "grep"
    case "fetch":
      return "webfetch"
    default:
      return "acp_tool"
  }
}

/** What the host is asked: the tool's locations when it names files, otherwise its title. */
export const check = (
  request: RequestPermissionRequest,
  input: { readonly sessionID: string; readonly agent?: string },
): DelegatedPermissionCheck => {
  const call = request.toolCall
  const paths = (call.locations ?? []).map((location) => location.path).filter(Boolean)
  return {
    sessionID: input.sessionID,
    ...(input.agent ? { agent: input.agent } : {}),
    action: action(call.kind),
    resources: paths.length ? paths : [call.title ?? call.toolCallId],
    metadata: { source: "acp", toolCallId: call.toolCallId, ...(call.title ? { title: call.title } : {}) },
  }
}

const pick = (options: readonly PermissionOption[], kinds: readonly PermissionOption["kind"][]) => {
  for (const kind of kinds) {
    const found = options.find((option) => option.kind === kind)
    if (found) return found
  }
  return undefined
}

/**
 * The agent's own option matching the host decision. The host already persisted any "always"
 * answer, so the agent is only told once; with no matching option the request is cancelled.
 */
export const respond = (request: RequestPermissionRequest, approved: boolean): RequestPermissionResponse => {
  const option = approved
    ? pick(request.options, ["allow_once", "allow_always"])
    : pick(request.options, ["reject_once", "reject_always"])
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } }
}
