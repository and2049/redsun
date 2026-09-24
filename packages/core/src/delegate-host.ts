export * as DelegateHost from "./delegate-host.js"

// REDSUN: the `ctx.delegate` plugin domain. Host capabilities a delegated runtime needs, exposed
// so a runtime plugin never imports core services.

import type { DelegateDomain, DelegatedCodeMode, DelegatedToolBinding } from "@opencode/plugin/effect/delegate"
import { Cause, Effect, Exit, Option } from "effect"
import { Agent } from "./agent.js"
import { CodeModeCatalog } from "./codemode/catalog.js"
import { CodeModeInstructions } from "./codemode/instructions.js"
import { Config } from "./config.js"
import { DelegatedRuntime } from "./delegate.js"
import { Form } from "./form.js"
import { KV } from "./kv.js"
import { Mcp } from "./mcp/index.js"
import { Permission } from "./permission.js"
import { PluginHooks } from "./plugin/hooks.js"
import { Session } from "./session.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"
import { Tool } from "./tool.js"
import { McpTool } from "./tool/mcp.js"

/** A correction typed into a decline, however deep the rejection wraps it. */
export const correctionFeedback = (error: unknown): string | undefined => {
  for (let node: unknown = error, depth = 0; node !== undefined && node !== null && depth < 4; depth++) {
    const candidate = node as { _tag?: unknown; feedback?: unknown; cause?: unknown; error?: unknown }
    if (candidate._tag === "Permission.CorrectedError" && typeof candidate.feedback === "string")
      return candidate.feedback
    node = candidate.cause ?? candidate.error
  }
  return undefined
}

/** Code Mode's catalog summary as a delegated runtime consumes it. */
export const codeMode = (summary: CodeModeCatalog.Summary): DelegatedCodeMode => ({
  summary,
  render: () => CodeModeInstructions.render(summary),
  update: (previous) => CodeModeInstructions.update(previous as CodeModeCatalog.Summary, summary),
})

/** Registered names of connected MCP tools exposed directly rather than through Code Mode. */
export const directNames = (connected: readonly Mcp.Tool[]): ReadonlySet<string> =>
  new Set(connected.filter((tool) => tool.codemode === false).map((tool) => McpTool.name(tool.server, tool.name)))

/** Binds a tool snapshot to one turn's attribution. */
export const bindSnapshot = (
  snapshot: Tool.Snapshot,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly direct: ReadonlySet<string>
  },
): DelegatedToolBinding => ({
  definitions: snapshot.definitions,
  direct: input.direct,
  ...(snapshot.codeModeCatalog ? { codeMode: codeMode(CodeModeCatalog.summarize(snapshot.codeModeCatalog)) } : {}),
  execute: ({ name, args, callID, allowed, signal }) =>
    Effect.runPromise(
      snapshot.execute({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.messageID,
        call: { type: "tool-call", id: callID, name, input: args } as never,
        ...(allowed === undefined
          ? {}
          : {
              definitions: new Map(
                snapshot.definitions.filter((item) => allowed.has(item.name)).map((item) => [item.name, item]),
              ),
            }),
      }),
      { signal },
    ),
})

export const make = Effect.gen(function* () {
  const delegates = yield* DelegatedRuntime.Service
  const hooks = yield* PluginHooks.Service
  const kv = yield* KV.Service
  const permission = yield* Permission.Service
  const agents = yield* Agent.Service
  const sessions = yield* Session.Service
  const tools = yield* Tool.Service
  const mcp = yield* Mcp.Service
  // Optional so every PluginHost stays constructible without them (standalone harnesses); the
  // instance graph always provides both.
  const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
  const forms = Option.getOrUndefined(yield* Effect.serviceOption(Form.Service))
  const missing = (name: string) => Effect.die(new Error(`${name} is not available to this plugin host.`))

  const check = (input: Parameters<DelegateDomain["permission"]["inspect"]>[0]) => ({
    action: input.action,
    resources: [...input.resources],
    sessionID: SessionSchema.ID.make(input.sessionID),
    ...(input.agent ? { agent: Agent.ID.make(input.agent) } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  })

  const domain: DelegateDomain = {
    register: (runtime) =>
      Effect.gen(function* () {
        const registered = yield* delegates.transform((editor) => editor.add(runtime))
        const tagged = yield* hooks.register("session", "model.request", DelegatedRuntime.tagRequest, {
          providerID: runtime.providerID,
        })
        return { dispose: Effect.andThen(tagged.dispose, registered.dispose) }
      }),
    owns: delegates.owns,
    config: (key) =>
      config ? config.entries().pipe(Effect.map((entries) => Config.latest(entries, key as never))) : missing("Config"),
    storage: (runtimeID) => {
      const prefix = `redsun.${runtimeID}`
      return {
        get: (key) => kv.get(prefix + key),
        set: (key, value) => kv.set(prefix + key, value),
        remove: (key) => kv.remove(prefix + key),
      }
    },
    permission: {
      inspect: (input) => permission.inspect(check(input)).pipe(Effect.orDie),
      assert: (input) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            permission.assert({ ...check(input), ...(input.save ? { save: [...input.save] } : {}) }),
          )
          if (Exit.isSuccess(exit)) return { ok: true as const }
          if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
          const feedback = correctionFeedback(Cause.squash(exit.cause))
          return feedback === undefined ? { ok: false as const } : { ok: false as const, feedback }
        }),
      mode: permission.mode,
    },
    tools: {
      bind: (input) =>
        Effect.gen(function* () {
          const sessionID = SessionSchema.ID.make(input.sessionID)
          const agent = Agent.ID.make(input.agent)
          const session = yield* sessions
            .get(sessionID)
            .pipe(Effect.mapError(() => new Error(`Session not found: ${sessionID}`)))
          const info = yield* agents.get(agent)
          if (!info) return yield* Effect.fail(new Error(`Agent is no longer available: ${agent}`))
          const snapshot = yield* tools.snapshot(Permission.merge(info.permissions, session.permissions ?? []))
          return bindSnapshot(snapshot, {
            sessionID,
            agent,
            messageID: SessionMessage.ID.make(input.messageID),
            direct: directNames(yield* mcp.tools()),
          })
        }),
    },
    form: {
      ask: (input) =>
        !forms
          ? missing("Form")
          : forms
              .ask({
                sessionID: input.sessionID as never,
                title: input.title,
                ...(input.metadata ? { metadata: input.metadata } : {}),
                fields: input.fields as never,
              })
              .pipe(Effect.orDie),
    },
  }
  return domain
})
