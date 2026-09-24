import { define } from "@opencode/plugin/effect/plugin"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Effect } from "effect"
import { AcpOptions } from "./options.js"
import { AcpRuntime } from "./runtime.js"

// REDSUN: delegated runtimes for external coding agents that speak ACP (Agent Client Protocol).
// A plugin in the ordinary sense: it reaches the host only through `ctx`, and core knows nothing
// about it. Each configured agent becomes a provider whose models the agent runs itself.

/** Never installed: core routes a registered runtime's models to it ahead of any SDK loading. */
export const PACKAGE = "aisdk:@redsun/runtime-acp"

/** The agent session a host session last used, under the runtime's storage prefix. */
const cursorKey = (sessionID: string) => `-session/${sessionID}`

const LIMIT = { context: 200_000, output: 32_000 }

export default define({
  id: "redsun.runtime.acp",
  effect: Effect.fn(function* (ctx) {
    const { agents, errors } = AcpOptions.parse(ctx.options)
    for (const error of errors) yield* Effect.logWarning(error)

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
    }

    for (const agent of agents) {
      const storage = ctx.delegate.storage(agent.id)
      const host: AcpRuntime.Host = {
        ...shared,
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
        for (const model of agent.models)
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
