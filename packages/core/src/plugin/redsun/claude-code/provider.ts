// REDSUN: registers the delegated Claude Code provider.
//
// Autodetected, matching V1: the provider appears only when the `claude` binary
// resolves. Sign-in is deliberately NOT probed at startup — that would cost a
// subprocess on every boot — so an unauthenticated CLI surfaces an actionable
// error on the first turn instead.
export * as ClaudeCodeProviderPlugin from "./provider.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { Model } from "@opencode-ai/schema/model"
import { Agent } from "../../../agent.js"
import { Bus } from "../../../bus.js"
import { Config } from "../../../config.js"
import { KV } from "../../../kv.js"
import { Location } from "../../../location.js"
import { Permission } from "../../../permission.js"
import { PluginRuntime } from "../../runtime.js"
import { SessionMessage } from "../../../session/message.js"
import { Tool } from "../../../tool.js"
import { ClaudeCodeExecutable } from "./executable.js"
import { ClaudeCodeLanguageModel } from "./language-model.js"
import { ClaudeCodeMcp } from "./mcp.js"
import { ClaudeCodeModes } from "./modes.js"
import { ClaudeCodeModels } from "./models.js"
import { ClaudeCodePermissions } from "./permissions.js"
import { ClaudeCodeQuery } from "./query.js"
import { ClaudeCodeSessions } from "./sessions.js"
import { ClaudeCodeSubagentEvents } from "./subagent-events.js"
import { ClaudeCodeSubagents } from "./subagents.js"

/**
 * Hidden agents that generate a title, a summary, or a compaction. They must run
 * one-shot: reusing the interactive process would inject their prompt into the
 * user's conversation and, for compaction, ask Claude Code to summarize a
 * transcript it already owns.
 */
const ONE_SHOT_AGENTS = new Set(["title", "summary", "compaction"])

const cursorKey = (sessionID: string) => `redsun.claude-code-session/${sessionID}`

export const Plugin = define({
  id: "redsun.provider.claude-code",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const settings = Config.latest(yield* config.entries(), "claude_code")
    if (settings?.enabled === false) return

    const resolution = ClaudeCodeExecutable.resolve(settings?.binary_path)
    if ("error" in resolution) {
      yield* Effect.logDebug("claude code provider unavailable", { reason: resolution.error })
      return
    }

    yield* ctx.catalog.transform((catalog) => {
      const info = ClaudeCodeModels.providerInfo()
      catalog.provider.update(ClaudeCodeModels.PROVIDER_ID, (provider) => {
        provider.name = info.name
        provider.activation = info.activation
        provider.package = info.package
      })
      for (const model of ClaudeCodeModels.MODELS) {
        catalog.model.update(ClaudeCodeModels.PROVIDER_ID, model.id, (draft) => {
          Object.assign(draft, model)
        })
      }
    })

    const location = yield* Location.Service
    const kv = yield* KV.Service
    const permission = yield* Permission.Service
    const tools = yield* Tool.Service
    const runtime = yield* PluginRuntime.Service
    const bus = yield* Bus.Service
    const agentRegistry = yield* Agent.Service

    // Resume cursors are read synchronously inside doStream, so keep a mirror of
    // the durable KV values in memory and write through on change.
    const cursors = new Map<string, string>()
    // Which agent is driving each session's current request, recorded by the
    // session context hook immediately before the model call for that session.
    const agents = new Map<string, string>()

    const manager = new ClaudeCodeSessions.SessionManager(ClaudeCodeQuery.defaultCreateQuery)

    /**
     * One mirror per delegated session, built lazily where the turn's model is
     * known so mirrored children carry the model that actually produced them.
     */
    const mirrors = new Map<string, ClaudeCodeSubagents.Mirror>()
    const mirrorFor = (sessionID: string, model: Model.Ref) => {
      const existing = mirrors.get(sessionID)
      if (existing) return existing
      const mirror = ClaudeCodeSubagents.make({
        parentSessionID: sessionID,
        ops: {
          messageID: () => SessionMessage.ID.create(),
          // Mirroring is best-effort: a failure here must degrade to V1's
          // pre-mirror behaviour (an opaque subagent tool call), never break
          // the user's turn.
          createChild: (input) =>
            Effect.runPromise(
              runtime.session
                .create({
                  parentID: sessionID as never,
                  title: input.title,
                  agent: Agent.ID.make(input.agent),
                  model,
                })
                .pipe(Effect.map((session) => session.id as string)),
            ).catch(() => undefined),
          publish: (events) =>
            Effect.runPromise(ClaudeCodeSubagentEvents.publish(bus, model, events)).catch(() => undefined),
        },
      })
      mirrors.set(sessionID, mirror)
      return mirror
    }

    yield* ctx.session.hook(
      "context",
      Effect.fn(function* (event) {
        agents.set(event.sessionID, event.agent)
        const stored = yield* kv.get(cursorKey(event.sessionID))
        if (typeof stored === "string" && stored) cursors.set(event.sessionID, stored)
      }),
    )

    /**
     * Claude Code owns its own read-only mode, so redsun's plan agent maps onto
     * the SDK's `plan` mode rather than being rebuilt out of tool denies. The
     * agent's own `mode` is what selects `worker_permission_mode`, so a worker
     * routed to a Claude Code model can be held to a tighter policy than the
     * primary session.
     */
    const permissionMode = async (sessionID: string) => {
      const agentID = agents.get(sessionID)
      const info = agentID ? await Effect.runPromise(agentRegistry.resolve(agentID)).catch(() => undefined) : undefined
      return ClaudeCodeModes.permissionMode({
        agentID,
        agentMode: info?.mode,
        configured: settings?.permission_mode,
        worker: settings?.worker_permission_mode,
      })
    }

    /**
     * Claude Code executes its own tools, so its approvals arrive here rather
     * than through v2's tool layer. Bridging them onto Permission.Service is
     * what makes a user's existing rules apply to delegated sessions.
     */
    const canUseTool =
      (sessionID: string) =>
      async (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal }) => {
        const worktree = location.directory
        const agent = agents.get(sessionID)
        const ask = (action: string, resource: string) =>
          Effect.runPromise(
            permission.ask({
              action,
              resources: [resource],
              save: [resource],
              sessionID: sessionID as never,
              ...(agent ? { agent: agent as never } : {}),
            }),
          ).catch(() => ({ effect: "deny" as const }))

        if (ClaudeCodePermissions.isReadOnly(toolName)) return { behavior: "allow" as const, updatedInput: input }
        if (options.signal.aborted) return { behavior: "deny" as const, message: "Interrupted" }

        // External directories are asked first, mirroring v2's own file tools.
        const external = ClaudeCodePermissions.externalDirectory({ toolName, input, worktree })
        if (external) {
          const outcome = await ask("external_directory", external)
          if (outcome.effect === "deny")
            return { behavior: "deny" as const, message: `Access to ${external} was denied` }
        }

        const mapped = ClaudeCodePermissions.mapPermission({ toolName, input, worktree })
        const outcome = await ask(mapped.action, mapped.resource)
        if (outcome.effect === "deny")
          return { behavior: "deny" as const, message: `Permission denied: ${mapped.action} ${mapped.resource}` }
        return { behavior: "allow" as const, updatedInput: input }
      }

    /**
     * Delegation for a Claude Code coordinator. Executes the upstream subagent
     * tool through the ordinary snapshot so permission asserts, depth limits and
     * worker-model resolution are reused. The permission layer does the gating,
     * so a worker (which denies `subagent`) gets a refusal rather than a missing
     * tool.
     */
    const delegate =
      (sessionID: string): ClaudeCodeMcp.Delegate =>
      async (args) => {
        const agent = agents.get(sessionID)
        if (!agent) throw new Error("Task delegation is not available for this session.")
        return Effect.runPromise(
          Effect.gen(function* () {
            const snapshot = yield* tools.snapshot()
            // The permission request is attributed to the session's newest
            // message, matching how an ordinary tool call would appear.
            const messages = yield* runtime.session.messages({ sessionID: sessionID as never, order: "desc", limit: 1 })
            const messageID = messages[0]?.id
            if (!messageID) return yield* Effect.fail(new Error("Session has no message to attribute the task to."))
            const result = yield* snapshot.execute({
              sessionID: sessionID as never,
              agent: agent as never,
              messageID,
              call: {
                type: "tool-call",
                id: `claude-code-subagent-${Date.now().toString(36)}`,
                name: "subagent",
                input: args,
              } as never,
            })
            return result.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n")
          }).pipe(
            Effect.catch((error) =>
              Effect.fail(error instanceof Error ? error : new Error(String((error as { message?: string })?.message ?? error))),
            ),
          ),
        )
      }

    yield* ctx.aisdk.hook(
      "language",
      Effect.fn(function* (event) {
        if (event.model.providerID !== ClaudeCodeModels.PROVIDER_ID) return
        const modelID = event.model.modelID ?? event.model.id
        const modelRef = Model.Ref.make({
          providerID: ClaudeCodeModels.PROVIDER_ID,
          id: Model.ID.make(modelID),
        })
        event.language = ClaudeCodeLanguageModel.make({
          modelID,
          config: {
            executablePath: resolution.path,
            cwd: location.directory,
            permissionMode: settings?.permission_mode,
            configDir: settings?.config_dir,
            extraArgs: settings?.extra_args,
            env: settings?.env,
          },
          manager,
          createQuery: ClaudeCodeQuery.defaultCreateQuery,
          hooks: {
            canUseTool,
            turnOptions: (sessionID) => ({
              mcpServers: { redsun: ClaudeCodeMcp.makeSubagentServer(delegate(sessionID)) },
            }),
            isOneShot: (sessionID) => ONE_SHOT_AGENTS.has(agents.get(sessionID) ?? ""),
            // The live map, never a copy: translate.ts captures this reference
            // before any child exists and reads it as children are minted.
            taskChildren: (sessionID) => mirrorFor(sessionID, modelRef).children(),
            observer: (sessionID, message) => mirrorFor(sessionID, modelRef).observe(message),
            onTurnEnd: (sessionID) => mirrors.get(sessionID)?.sweep(),
            permissionMode,
            resumeCursor: (sessionID) => cursors.get(sessionID),
            onCursor: (sessionID, claudeSessionID) => {
              if (cursors.get(sessionID) === claudeSessionID) return
              cursors.set(sessionID, claudeSessionID)
              Effect.runFork(kv.set(cursorKey(sessionID), claudeSessionID))
            },
          },
        })
      }),
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        manager.stopAll()
        mirrors.clear()
      }),
    )
  }),
})
