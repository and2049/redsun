import { accessSync, constants } from "node:fs"
import path from "node:path"
import { define } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Credential } from "@opencode/schema/credential"
import { Integration } from "@opencode/schema/integration"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Effect, Stream } from "effect"
import type { AcpModels } from "./models.js"
import { AcpOptions } from "./options.js"
import { AcpRuntime } from "./runtime.js"

// REDSUN: delegated runtimes for external coding agents that speak ACP (Agent Client Protocol).
// A plugin in the ordinary sense: it reaches the host only through `ctx`, and core knows nothing
// about it. Each agent becomes an integration to connect and a provider whose models the agent
// runs itself. Bundled, it reads the `acp` config key and offers the built-in agents (Kiro) whose
// command is installed; loaded by path, it takes its agents from the plugin options instead.

/** Never installed: core routes a registered runtime's models to it ahead of any SDK loading. */
export const PACKAGE = "aisdk:@redsun/runtime-acp"

/** The agent session a host session last used, under the runtime's storage prefix. */
const cursorKey = (sessionID: string) => `-session/${sessionID}`

/** The model list the agent last reported. */
const MODELS_KEY = ".models"

const discovered = (value: unknown): AcpModels.Discovered[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item?.id === "string" && item.id
          ? [{ id: item.id, name: typeof item.name === "string" && item.name ? item.name : item.id }]
          : [],
      )
    : []

/** The one connection method: the agent's own CLI sign-in, checked rather than performed. */
const METHOD_ID = Integration.MethodID.make("acp-cli-login")

/** Whether a command resolves on PATH (or is an executable path). */
const installed = (command: string) => {
  const executable = (file: string) => {
    try {
      accessSync(file, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (command.includes(path.sep)) return executable(command)
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => executable(path.join(dir, command)))
}

const LIMIT = { context: 200_000, output: 32_000 }

export default define({
  id: "redsun.runtime.acp",
  effect: Effect.fn(function* (ctx) {
    // Loaded by path, the plugin options name the agents; bundled, it gets empty options.
    const byPath = typeof ctx.options === "object" && ctx.options !== null && "agents" in ctx.options
    const configured = byPath
      ? ctx.options
      : {
          agents: AcpOptions.withBuiltins(
            ((yield* ctx.delegate.config("acp")) as { agents?: Record<string, unknown> } | undefined)?.agents ?? {},
            installed,
          ),
        }
    const { agents, errors } = AcpOptions.parse(configured)
    for (const error of errors) yield* Effect.logWarning(error)

    // A session is a worker once any of its turns ran under a parent session.
    const workers = new Set<string>()
    const shared: AcpRuntime.Host = {
      cwd: ctx.location.directory,
      mode: () => Effect.runPromise(ctx.delegate.permission.mode()),
      approve: (check) => Effect.runPromise(ctx.delegate.permission.assert(check)),
      tools: (turn) =>
        turn.assistantMessageID
          ? Effect.runPromise(
              ctx.delegate.tools.bind({
                sessionID: turn.sessionID,
                agent: turn.agent,
                messageID: turn.assistantMessageID,
              }),
            )
          : Promise.resolve(undefined),
      context: async (turn, input) => {
        if (turn.parentID) workers.add(turn.sessionID)
        const info = await Effect.runPromise(
          ctx.agent.get({ agentID: Agent.ID.make(turn.agent) }).pipe(
            Effect.map((result) => result.data),
            Effect.orElseSucceed(() => undefined),
          ),
        )
        const files = await Effect.runPromise(ctx.delegate.context.instructions())
        const skills = input.skills
          ? await Effect.runPromise(ctx.delegate.context.skills({ sessionID: turn.sessionID, agent: turn.agent }))
          : []
        return {
          agent: { id: turn.agent, mode: info?.mode, system: info?.system },
          isWorker: workers.has(turn.sessionID),
          ...(files === undefined ? {} : { files }),
          skills,
        }
      },
    }

    for (const agent of agents) {
      const storage = ctx.delegate.storage(agent.id)
      let reported = discovered(yield* storage.get(MODELS_KEY))
      const onModels = (models: readonly AcpModels.Discovered[]) => {
        const next = models.map((model) => ({ id: model.id, name: model.name }))
        if (JSON.stringify(next) === JSON.stringify(reported)) return
        reported = next
        Effect.runFork(storage.set(MODELS_KEY, next).pipe(Effect.andThen(ctx.provider.reload())))
      }
      const host: AcpRuntime.Host = {
        ...shared,
        onModels,
        cursor: {
          get: (sessionID) =>
            Effect.runPromise(storage.get(cursorKey(sessionID))).then((value) =>
              typeof value === "string" && value ? value : undefined,
            ),
          set: (sessionID, acpSessionID) => Effect.runPromise(storage.set(cursorKey(sessionID), acpSessionID)),
        },
      }
      yield* ctx.provider.transform((editor) => {
        editor.update(agent.id, (provider) => {
          provider.name = agent.name
          // Listed once the user connects the agent's integration.
          provider.activation = "auto"
          provider.package = PACKAGE
        })
        const models = agent.models.length
          ? agent.models
          : [{ id: "default", name: agent.name }, ...reported.filter((model) => model.id !== "default")]
        for (const model of models)
          editor.models.update(agent.id, model.id, (draft) => {
            Object.assign(draft, {
              ...Model.Info.default(Provider.ID.make(agent.id), Model.ID.make(model.id)),
              name: model.name,
              package: PACKAGE,
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: LIMIT,
            })
          })
      })

      const runtime = new AcpRuntime.Runtime(agent, host)
      yield* Effect.addFinalizer(() => Effect.sync(() => runtime.stop()))
      // A deleted host session releases its agent process and the agent session it remembered.
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "session.deleted"),
        Stream.runForEach((event) => {
          const sessionID = (event.data as { sessionID?: unknown }).sessionID
          if (typeof sessionID !== "string") return Effect.void
          runtime.drop(sessionID)
          return storage.remove(cursorKey(sessionID))
        }),
        Effect.forkScoped({ startImmediately: true }),
      )

      const label = `${agent.integration.name} CLI (existing sign-in)`
      yield* ctx.integration.transform((draft) => {
        draft.update(agent.id, (integration) => {
          integration.name = agent.integration.name
        })
        draft.method.update({
          integrationID: agent.id,
          method: { id: METHOD_ID, type: "oauth", label },
          authorize: () =>
            Effect.succeed({
              mode: "auto" as const,
              url: agent.integration.url,
              instructions: `Checking the ${agent.integration.name} CLI you are already signed in to. No browser sign-in is needed.`,
              callback: Effect.tryPromise({
                // Connecting also learns the model list, unless the config names models or one is
                // cached; later agent sessions keep it current. Nothing starts the agent before.
                try: () =>
                  runtime.signedIn().then((metadata) => {
                    if (!agent.models.length && !reported.length) void runtime.discover().catch(() => {})
                    return metadata
                  }),
                catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
              }).pipe(
                Effect.map((metadata) =>
                  Credential.OAuth.make({
                    type: "oauth",
                    methodID: METHOD_ID,
                    access: "acp-cli-login",
                    refresh: "acp-cli-login",
                    expires: 0,
                    ...(Object.keys(metadata).length ? { metadata } : {}),
                  }),
                ),
              ),
            }),
          label: (credential: Credential.OAuth) => {
            const metadata = (credential.metadata ?? {}) as Record<string, unknown>
            const email = typeof metadata.email === "string" ? metadata.email : undefined
            const kind = typeof metadata.accountType === "string" ? metadata.accountType : undefined
            return email && kind ? `${email} (${kind})` : (email ?? agent.integration.name)
          },
        } as never)
      })
      yield* ctx.delegate.register({
        id: agent.id,
        providerID: agent.id,
        turn: (turn, options) => runtime.turn(turn, options),
        compaction: agent.compactCommand
          ? {
              notice: `${agent.name} compacts its own context; sending ${agent.compactCommand}.`,
              command: agent.compactCommand,
            }
          : { notice: `${agent.name} manages its own context.` },
        // Only an agent with a real auto-approval mode gets the third permission mode.
        ...(AcpOptions.hasNativeApproval(agent) ? { nativeApproval: () => true } : {}),
      })
    }
  }),
})
