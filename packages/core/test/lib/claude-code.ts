import { DelegateHost } from "@opencode/core/delegate-host"
import { ClaudeCodeHostTools } from "@opencode/core/plugin/redsun/claude-code/host-tools"
import type { Tool } from "@opencode/core/tool"

/** A Claude Code host execution over a real core tool snapshot, as `ctx.delegate.tools.bind` builds it. */
export const hostFromSnapshot = (input: {
  readonly snapshot: Tool.Snapshot
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly allowed?: ReadonlySet<string>
  readonly onResult?: ClaudeCodeHostTools.HostExecution["onResult"]
}) =>
  ClaudeCodeHostTools.fromBinding({
    binding: DelegateHost.bindSnapshot(input.snapshot, {
      sessionID: input.sessionID as never,
      agent: input.agent as never,
      messageID: input.messageID as never,
      direct: new Set(),
    }),
    messageID: input.messageID,
    ...(input.allowed === undefined ? {} : { allowed: input.allowed }),
    ...(input.onResult === undefined ? {} : { onResult: input.onResult }),
  })
