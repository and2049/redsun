export * as AcpOptions from "./options.js"

import os from "node:os"
import path from "node:path"

/**
 * One external agent spoken to over ACP (Agent Client Protocol), from the plugin's config entry:
 *
 * ```jsonc
 * { "plugins": [{ "package": "/path/to/packages/runtime-acp", "options": { "agents": {
 *   "kiro": { "preset": "kiro" },
 *   "other": { "name": "Other", "command": "other-agent", "args": ["--acp"] }
 * } } }] }
 * ```
 *
 * A `preset` supplies the settings a known agent needs; the entry's own keys override it.
 */
export interface Agent {
  /** Provider id; also the runtime id and the storage prefix. */
  readonly id: string
  /** Provider display name in pickers. */
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /**
   * Models to list, when configured. Otherwise the provider lists `default` (the agent's own
   * choice) plus the model list the agent reports.
   */
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
  /**
   * Instruction files the agent loads itself, so the host does not send them again. Paths are
   * relative to the working directory (Kiro reads `AGENTS.md` there).
   */
  readonly inheritedInstructions: readonly string[]
  /**
   * Which host tools the agent gets. `extras` adds the host's own tools (subagent, skill, todo,
   * worker model and directly exposed MCP tools) to the agent's native ones; `all` serves the
   * whole tool set a native redsun agent has, for agents confined to host tools (see `home`).
   */
  readonly hostTools: "extras" | "all"
  /**
   * A home directory the host manages for the agent: `env` names the variable that points the
   * agent at it and `files` are written into it (JSON values as JSON) before the agent starts.
   */
  readonly home?: {
    readonly env: string
    readonly path: string
    readonly files: Readonly<Record<string, string>>
  }
  /**
   * The integration the user connects to reach the agent's models. `whoami` runs the agent's
   * command with these arguments to check its own sign-in (JSON output names the account);
   * without it, connecting checks that the agent starts an ACP session.
   */
  readonly integration: {
    readonly name: string
    readonly url: string
    readonly whoami?: readonly string[]
    readonly signIn?: string
  }
  /** A prompt the agent understands as "compact your context" (e.g. `/compact`). */
  readonly compactCommand?: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const string = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)

/** Where the host keeps an agent's home unless the config names one: redsun's data directory. */
export const defaultHome = (id: string) =>
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "redsun", "runtime-acp", id)

/**
 * Kiro confined to redsun's tools: a `redsun` agent profile whose only tools come from the host's
 * MCP server, in a Kiro home redsun owns (the user's ~/.kiro is left alone; Kiro's login lives in
 * its data directory, not its home). File edits, shell commands and every other tool therefore run
 * as redsun's own, with redsun's permissions, snapshots and rendering. Kiro's native approval
 * flag is moot when none of its own tools run, so the preset offers no native approval mode.
 */
const KIRO_AGENT = {
  name: "redsun",
  description: "Kiro driven by redsun: every tool is redsun's.",
  tools: ["@redsun"],
  allowedTools: ["@redsun"],
}

export const PRESETS: Readonly<Record<string, Record<string, unknown>>> = {
  kiro: {
    name: "Kiro-cli",
    command: "kiro-cli",
    integration: {
      name: "Kiro",
      url: "https://kiro.dev/",
      whoami: ["whoami", "--format", "json"],
      signIn: "Run `kiro-cli login` in a terminal, then connect again.",
    },
    args: ["acp", "--agent", KIRO_AGENT.name],
    hostTools: "all",
    compactCommand: "/compact",
    home: { env: "KIRO_HOME", files: { [`agents/${KIRO_AGENT.name}.json`]: KIRO_AGENT } },
  },
}

/**
 * Agents redsun offers without configuration when their command is installed. A configured entry
 * with the same id adjusts the built-in one.
 */
export const BUILTIN: Readonly<Record<string, { readonly preset: string; readonly command: string }>> = {
  kiro: { preset: "kiro", command: "kiro-cli" },
}

/** Config entries with the built-in agents added: those whose command is installed, or configured. */
export const withBuiltins = (
  configured: Readonly<Record<string, unknown>>,
  installed: (command: string) => boolean,
): Record<string, unknown> => {
  const agents: Record<string, unknown> = {}
  for (const [id, builtin] of Object.entries(BUILTIN)) {
    const own = record(configured[id])
    if (own) agents[id] = { preset: builtin.preset, ...own }
    else if (installed(builtin.command)) agents[id] = { preset: builtin.preset }
  }
  for (const [id, entry] of Object.entries(configured)) if (!(id in agents)) agents[id] = entry
  return agents
}

/** Config keys are snake_case (`host_tools`); plugin options are camelCase. Both are accepted. */
const camel = (entry: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(entry).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
      value,
    ]),
  )

/** Whether the agent has any real auto-approval to offer as `native_auto`. */
export const hasNativeApproval = (agent: Agent) => Boolean(agent.nativeApprovalMode || agent.nativeApprovalArgs?.length)

const integration = (name: string, value: Record<string, unknown> | undefined): Agent["integration"] => {
  const whoami = Array.isArray(value?.whoami)
    ? value.whoami.filter((item): item is string => typeof item === "string")
    : undefined
  return {
    name: string(value?.name) ?? name,
    url: string(value?.url) ?? "",
    ...(whoami?.length ? { whoami } : {}),
    ...(string(value?.signIn) ? { signIn: string(value?.signIn) } : {}),
  }
}

const home = (id: string, value: Record<string, unknown> | undefined, errors: string[]) => {
  if (!value) return {}
  const env = string(value.env)
  if (!env) {
    errors.push(`ACP agent "${id}" has a home without an env variable; ignoring it.`)
    return {}
  }
  const configured = string(value.path)
  const files = Object.fromEntries(
    Object.entries(record(value.files) ?? {}).map(([name, content]) => [
      name,
      typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n",
    ]),
  )
  return {
    home: {
      env,
      path: configured ? path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir())) : defaultHome(id),
      files,
    },
  }
}

/** Parses `ctx.options`; malformed agents are reported, not thrown. */
export const parse = (options: unknown): { readonly agents: Agent[]; readonly errors: string[] } => {
  const agents: Agent[] = []
  const errors: string[] = []
  const configured = record(record(options)?.agents) ?? {}
  for (const [id, raw] of Object.entries(configured)) {
    const own = record(raw) && camel(record(raw)!)
    if (own?.enabled === false) continue
    const presetName = string(own?.preset)
    const preset = presetName ? PRESETS[presetName] : undefined
    if (presetName && !preset) {
      errors.push(`ACP agent "${id}" names an unknown preset "${presetName}".`)
      continue
    }
    const entry: Record<string, unknown> | undefined = own && {
      ...preset,
      ...own,
      env: { ...record(preset?.env), ...record(own.env) },
      ...(preset?.home || own.home ? { home: { ...record(preset?.home), ...record(own.home) } } : {}),
      integration: { ...record(preset?.integration), ...record(own.integration) },
    }
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
      models,
      inheritedInstructions: Array.isArray(entry.inheritedInstructions)
        ? entry.inheritedInstructions.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [],
      ...(string(entry.nativeApprovalMode) ? { nativeApprovalMode: string(entry.nativeApprovalMode) } : {}),
      ...(nativeApprovalArgs.length ? { nativeApprovalArgs } : {}),
      ...(string(entry.defaultMode) ? { defaultMode: string(entry.defaultMode) } : {}),
      ...(string(entry.compactCommand) ? { compactCommand: string(entry.compactCommand) } : {}),
      hostTools: entry.hostTools === "all" ? "all" : "extras",
      integration: integration(name, record(entry.integration)),
      ...home(id, record(entry.home), errors),
    })
  }
  return { agents, errors }
}
