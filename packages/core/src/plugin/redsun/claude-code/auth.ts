export * as ClaudeCodeAuth from "./auth.js"

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { Effect } from "effect"
import { Credential } from "@opencode-ai/schema/credential"
import { Integration } from "../../../integration.js"
import { ClaudeCodeModels } from "./models.js"
import type { ClaudeCodeSessions } from "./sessions.js"

export const METHOD_ID = Integration.MethodID.make("claude-code-cli")
export const INTEGRATION_ID = Integration.ID.make(ClaudeCodeModels.PROVIDER_ID)
export const LABEL = "Claude Code CLI (Pro/Max subscription)"

export const NOT_SIGNED_IN =
  "The Claude Code CLI is not signed in. Run `claude` in a terminal, sign in with `/login`, then connect again."

export const TIMEOUT = "20 seconds"

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}

const string = (value: unknown) => (typeof value === "string" && value ? value : undefined)

const idlePrompt = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) } as never

export const accountMetadata = (account: unknown): Record<string, string> | undefined => {
  const value = record(account)
  const metadata = {
    ...(string(value["email"]) ? { email: string(value["email"]) } : {}),
    ...(string(value["organization"]) ? { organization: string(value["organization"]) } : {}),
    ...(string(value["subscriptionType"]) ? { subscriptionType: string(value["subscriptionType"]) } : {}),
    ...(string(value["apiProvider"]) ? { apiProvider: string(value["apiProvider"]) } : {}),
  }
  return Object.keys(metadata).length ? metadata : undefined
}

export const probe = (input: {
  readonly createQuery: ClaudeCodeSessions.CreateQuery
  readonly options: Options
}): Effect.Effect<Credential.OAuth, Error> =>
  Effect.tryPromise({
    try: async () => {
      const query = input.createQuery({
        prompt: idlePrompt,
        options: { ...input.options, maxTurns: 1, allowedTools: [], strictMcpConfig: true, persistSession: false },
      })
      try {
        const account = query.accountInfo
          ? await query.accountInfo()
          : query.initializationResult
            ? record(await query.initializationResult())["account"]
            : undefined
        return accountMetadata(account)
      } finally {
        try {
          query.close()
        } catch {}
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.fail(new Error(NOT_SIGNED_IN)) }),
    Effect.flatMap(
      (metadata): Effect.Effect<Credential.OAuth, Error> =>
        metadata === undefined
          ? Effect.fail(new Error(NOT_SIGNED_IN))
          : Effect.succeed(
              Credential.OAuth.make({
                type: "oauth",
                methodID: METHOD_ID,
                access: "claude-code-cli",
                refresh: "claude-code-cli",
                expires: 0,
                metadata,
              }),
            ),
    ),
  )

export const oauth = (input: {
  readonly createQuery: ClaudeCodeSessions.CreateQuery
  readonly options: Options
}) =>
  ({
    integrationID: INTEGRATION_ID,
    method: { id: METHOD_ID, type: "oauth", label: LABEL },
    authorize: () =>
      Effect.succeed({
        mode: "auto" as const,
        url: "https://claude.ai/",
        instructions: "Checking the Claude Code CLI you are already signed in to. No browser sign-in is needed.",
        callback: probe(input) as Effect.Effect<Credential.OAuth, unknown>,
      }),
    label: (credential: Credential.OAuth) => {
      const metadata = record(credential.metadata)
      const email = string(metadata["email"])
      const plan = string(metadata["subscriptionType"])
      if (email && plan) return `${email} (${plan})`
      return email ?? plan ?? "Claude Code CLI"
    },
  }) as const
