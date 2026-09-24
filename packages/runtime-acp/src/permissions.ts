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

const field = (input: unknown, names: readonly string[]) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  for (const name of names) {
    const value = (input as Record<string, unknown>)[name]
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

/**
 * What a host rule matches against: the tool's locations when it names files; the command for a
 * shell call and the URL for a fetch, read from the agent's raw input (ACP names no fields, so the
 * common spellings are tried); otherwise the title.
 */
export const resources = (call: RequestPermissionRequest["toolCall"]): string[] => {
  const paths = (call.locations ?? []).map((location) => location.path).filter(Boolean)
  if (paths.length) return paths
  const raw =
    call.kind === "execute"
      ? field(call.rawInput, ["command", "cmd", "commandLine", "script"])
      : call.kind === "fetch"
        ? field(call.rawInput, ["url", "uri"])
        : field(call.rawInput, ["path", "file_path", "filePath", "file"])
  return [raw ?? call.title ?? call.toolCallId]
}

/** What the host is asked for an agent's own tool call. */
export const check = (
  request: RequestPermissionRequest,
  input: { readonly sessionID: string; readonly agent?: string },
): DelegatedPermissionCheck => {
  const call = request.toolCall
  return {
    sessionID: input.sessionID,
    ...(input.agent ? { agent: input.agent } : {}),
    action: action(call.kind),
    resources: resources(call),
    metadata: { source: "acp", toolCallId: call.toolCallId, ...(call.title ? { title: call.title } : {}) },
  }
}

/** The user's correction on a decline, as the agent reads it with its next prompt. */
export const correction = (call: RequestPermissionRequest["toolCall"], feedback: string) =>
  `The user declined ${call.title ? `"${call.title}"` : "a tool call"} and said: ${feedback}`

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
