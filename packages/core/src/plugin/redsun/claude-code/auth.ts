// REDSUN: the Claude Code "connect" flow.
//
// This method never signs anybody in. Redsun drives the user's already
// installed, already signed-in `claude` CLI and never touches Anthropic
// subscription credentials itself — that is the whole compliance posture (ADR in
// `.redsun/plans/claude-code.md`), so `claude login` / `setup-token` are not run
// from here and never should be. Connecting only *verifies* the CLI's existing
// sign-in and records who it belongs to, so the provider dialog can show the
// account instead of a static label.
//
// Verification is a throwaway `query()` whose prompt never yields: the SDK
// resolves its init handshake in the constructor, independently of anyone
// iterating the message stream, so reading the account costs one short-lived
// process and no model call.
//
// The stored credential is a marker, not a secret. A plugin-registered OAuth
// method must return `Credential.OAuth` (there is no `Credential.Key` path from
// a plugin), so the marker lives in `access`/`refresh` and the account details
// live in `metadata`. `expires: 0` with no `refresh` implementation means it is
// never refreshed, matching github-copilot.ts.
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

/** How long to wait for the CLI's init handshake before giving up. */
export const TIMEOUT = "20 seconds"

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {}

const string = (value: unknown) => (typeof value === "string" && value ? value : undefined)

/** A prompt that never yields: the probe wants the handshake, not a turn. */
const idlePrompt = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) } as never

/** Account fields worth showing. Never tokens — `metadata` is displayed. */
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

/**
 * Verify the CLI's existing sign-in and describe the account behind it.
 * Fails when the CLI cannot report an account, which is what "not signed in"
 * looks like from out here.
 */
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
        } catch {
          // Already gone; nothing to release.
        }
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
                // Marker, not a secret: redsun holds no Anthropic token.
                access: "claude-code-cli",
                refresh: "claude-code-cli",
                expires: 0,
                metadata,
              }),
            ),
    ),
  )

/**
 * The connect method. v2 has no generic credential-metadata display surface
 * (`Connection.Info` carries `{type, id, label}` only), so `label` is how the
 * account reaches the dialog — one string, and never a token.
 */
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
