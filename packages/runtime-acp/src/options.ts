export * as AcpOptions from "./options.js"

/**
 * One external agent spoken to over ACP (Agent Client Protocol), from the plugin's config entry:
 *
 * ```jsonc
 * { "plugins": [{ "package": "/path/to/packages/runtime-acp", "options": { "agents": {
 *   "kiro": { "name": "Kiro-cli", "command": "kiro-cli", "args": ["acp"] }
 * } } }] }
 * ```
 */
export interface Agent {
  /** Provider id; also the runtime id and the storage prefix. */
  readonly id: string
  /** Provider display name in pickers. */
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly models: ReadonlyArray<{ readonly id: string; readonly name: string }>
  /**
   * The agent's own ACP session mode that auto-approves (e.g. a "trust all tools" mode). Only when
   * set does the host offer `native_auto`, mapped onto this mode. Name the agent's real mode id;
   * nothing is guessed from mode names.
   */
  readonly nativeApprovalMode?: string
  /**
   * Launch flags that make the agent auto-approve, for an agent whose auto-approval is a process
   * flag rather than a session mode (Kiro's `--trust-all-tools`). Only when set does the host offer
   * `native_auto`; switching into or out of it restarts the agent at the start of the next turn and
   * reloads the conversation (`session/load`) where the agent supports it.
   */
  readonly nativeApprovalArgs?: readonly string[]
  /** The mode to restore when `native_auto` is not selected. Defaults to the session's initial mode. */
  readonly defaultMode?: string
  /** A prompt the agent understands as "compact your context" (e.g. `/compact`). */
  readonly compactCommand?: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const string = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)

/** Whether the agent has any real auto-approval to offer as `native_auto`. */
export const hasNativeApproval = (agent: Agent) => Boolean(agent.nativeApprovalMode || agent.nativeApprovalArgs?.length)

/** Parses `ctx.options`; malformed agents are reported, not thrown. */
export const parse = (options: unknown): { readonly agents: Agent[]; readonly errors: string[] } => {
  const agents: Agent[] = []
  const errors: string[] = []
  const configured = record(record(options)?.agents) ?? {}
  for (const [id, raw] of Object.entries(configured)) {
    const entry = record(raw)
    const command = string(entry?.command)
    if (!entry || !command) {
      errors.push(`ACP agent "${id}" needs a command.`)
      continue
    }
    const name = string(entry.name) ?? id
    const args = Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === "string") : []
    const env = Object.fromEntries(
      Object.entries(record(entry.env) ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
    )
    const nativeApprovalArgs = Array.isArray(entry.nativeApprovalArgs)
      ? entry.nativeApprovalArgs.filter((item): item is string => typeof item === "string" && item.length > 0)
      : []
    const models = (Array.isArray(entry.models) ? entry.models : [])
      .map((item) => (typeof item === "string" ? { id: item } : record(item)))
      .flatMap((item) => {
        const modelID = string(item?.id)
        return modelID ? [{ id: modelID, name: string(item?.name) ?? modelID }] : []
      })
    agents.push({
      id,
      name,
      command,
      args,
      env,
      models: models.length ? models : [{ id: "default", name }],
      ...(string(entry.nativeApprovalMode) ? { nativeApprovalMode: string(entry.nativeApprovalMode) } : {}),
      ...(nativeApprovalArgs.length ? { nativeApprovalArgs } : {}),
      ...(string(entry.defaultMode) ? { defaultMode: string(entry.defaultMode) } : {}),
      ...(string(entry.compactCommand) ? { compactCommand: string(entry.compactCommand) } : {}),
    })
  }
  return { agents, errors }
}
