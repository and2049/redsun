import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { CreateQuery, QueryLike } from "./sessions"

/**
 * Verifies the local Claude Code CLI's sign-in state without running a turn:
 * a throwaway query whose prompt never yields, read `initializationResult()`
 * (account email / subscription / backend), then close. Never runs
 * `claude login` or `claude setup-token` — sign-in stays owned by the CLI.
 */

export type ProbeAccount = {
  email?: string
  subscription?: string
  apiProvider?: string
}

export type ProbeResult = { ok: true; account: ProbeAccount } | { ok: false; error: string }

const NOT_SIGNED_IN =
  "Claude Code is not signed in. Run `claude` in a terminal, sign in with /login, then try again."

function neverYields(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
  }
}

const defaultCreateQuery: CreateQuery = (input) => {
  // Same contract as runtime.ts: never let the SDK fall back to its bundled
  // cli.js — the probe must verify the user's installed CLI, nothing else.
  if (!input.options.pathToClaudeCodeExecutable)
    throw new Error("Claude Code probe is missing pathToClaudeCodeExecutable; refusing to spawn the SDK's bundled CLI")
  return query(input) as QueryLike
}

export async function probe(input: {
  executablePath: string
  configDir?: string
  env?: Record<string, string>
  timeoutMs?: number
  createQuery?: CreateQuery
}): Promise<ProbeResult> {
  const createQuery = input.createQuery ?? defaultCreateQuery
  let handle: QueryLike | undefined
  try {
    handle = createQuery({
      prompt: neverYields(),
      options: {
        pathToClaudeCodeExecutable: input.executablePath,
        persistSession: false,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        env: {
          ...process.env,
          ...input.env,
          ...(input.configDir ? { CLAUDE_CONFIG_DIR: input.configDir } : {}),
        },
        stderr: () => {},
      },
    })
    if (!handle.initializationResult) return { ok: false, error: "Claude Code CLI does not support the init handshake" }

    // Bedrock/gateway backends can take a while to initialize.
    const timeoutMs = input.timeoutMs ?? 20_000
    const init = await Promise.race([
      handle.initializationResult(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for Claude Code to initialize")), timeoutMs),
      ),
    ])

    const account = (init as { account?: { email?: string; subscriptionType?: string; apiProvider?: string } }).account
    if (!account || (!account.email && !account.subscriptionType && !account.apiProvider)) {
      return { ok: false, error: NOT_SIGNED_IN }
    }
    return {
      ok: true,
      account: {
        ...(account.email ? { email: account.email } : {}),
        ...(account.subscriptionType ? { subscription: account.subscriptionType } : {}),
        ...(account.apiProvider ? { apiProvider: account.apiProvider } : {}),
      },
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      handle?.close()
    } catch {
      // process already gone
    }
  }
}

export * as ClaudeCodeProbe from "./probe"
