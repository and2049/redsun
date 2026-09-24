import { define } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Effect } from "effect"
import type { AcpModels } from "./models.js"
import { AcpOptions } from "./options.js"
import { AcpRuntime } from "./runtime.js"

// REDSUN: delegated runtimes for external coding agents that speak ACP (Agent Client Protocol).
// A plugin in the ordinary sense: it reaches the host only through `ctx`, and core knows nothing
// about it. Each configured agent becomes a provider whose models the agent runs itself.

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

const LIMIT = { context: 200_000, output: 32_000 }

export default define({
  id: "redsun.runtime.acp",
  effect: Effect.fn(function* (ctx) {
    const { agents, errors } = AcpOptions.parse(ctx.options)
    for (const error of errors) yield* Effect.logWarning(error)

    // A session is a worker once any of its turns ran under a parent session.
    const workers = new Set<string>()
    const shared: AcpRuntime.Host = {
      cwd: ctx.location.directory,
      mode: () => Effect.runPromise(ctx.delegate.permission.mode()),
      approve: (check) => Effect.runPromise(ctx.delegate.permission.assert(check)).then((result) => result.ok),
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
          provider.activation = "enabled"
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
      // Learn the model list once, in the background; later sessions keep it current.
      if (!agent.models.length && !reported.length) void runtime.discover().catch(() => {})
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
