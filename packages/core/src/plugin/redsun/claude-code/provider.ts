export * as ClaudeCodeProviderPlugin from "./provider.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { Model } from "@opencode-ai/schema/model"
import { Agent } from "../../../agent.js"
import { Bus } from "../../../bus.js"
import { Config } from "../../../config.js"
import { Form } from "../../../form.js"
import { KV } from "../../../kv.js"
import { Location } from "../../../location.js"
import { Permission } from "../../../permission.js"
import { Session } from "../../../session.js"
import { SessionEvent } from "../../../session/event.js"
import { SessionMessage } from "../../../session/message.js"
import { Tool } from "../../../tool.js"
import { ClaudeCodeAuth } from "./auth.js"
import { ClaudeCodeExecutable } from "./executable.js"
import { ClaudeCodeLanguageModel } from "./language-model.js"
import { ClaudeCodeMcp } from "./mcp.js"
import { ClaudeCodeModes } from "./modes.js"
import { ClaudeCodeModels } from "./models.js"
import { ClaudeCodePermissionBridge } from "./permission-bridge.js"
import { ClaudeCodePermissions } from "./permissions.js"
import { ClaudeCodeQuery } from "./query.js"
import { ClaudeCodeQuestions } from "./questions.js"
import { ClaudeCodeSessions } from "./sessions.js"
import { ClaudeCodeSubagentEvents } from "./subagent-events.js"
import { ClaudeCodeSubagents } from "./subagents.js"
import { ClaudeCodeTurnBrief } from "./turn-brief.js"

const ONE_SHOT_AGENTS = new Set(["title", "summary", "compaction"])

const cursorKey = (sessionID: string) => `redsun.claude-code-session/${sessionID}`

const RETIRED_KEY = "redsun.claude-code.retired"
const DISCOVERED_KEY = "redsun.claude-code.discovered"

const correctionFeedback = (error: unknown): string | undefined => {
  for (let node: unknown = error, depth = 0; node !== undefined && node !== null && depth < 4; depth++) {
    const candidate = node as { _tag?: unknown; feedback?: unknown; cause?: unknown; error?: unknown }
    if (candidate._tag === "Permission.CorrectedError" && typeof candidate.feedback === "string")
      return candidate.feedback
    node = candidate.cause ?? candidate.error
  }
  return undefined
}

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

    const kv = yield* KV.Service

    // The registry keeps itself fresh through two KV-backed inputs re-applied
    // on every catalog reload: pinned ids the CLI was observed substituting
    // (hidden until config resurrects them) and the CLI's own picker rows
    // (probed per spawned session, since no API enumerates what a
    // subscription can reach ahead of time).
    const retired = ClaudeCodeModels.parseRetired(
      yield* kv.get(RETIRED_KEY).pipe(Effect.orElseSucceed(() => undefined)),
    )
    let discovered = ClaudeCodeModels.parseDiscovered(
      yield* kv.get(DISCOVERED_KEY).pipe(Effect.orElseSucceed(() => undefined)),
    )

    yield* ctx.catalog.transform((draft) => ClaudeCodeModels.applyCatalog(draft, { retired, discovered }))

    yield* ctx.integration.transform((draft) => {
      draft.update(ClaudeCodeModels.PROVIDER_ID, (integration) => {
        integration.name = ClaudeCodeModels.DISPLAY_NAME
      })
      draft.method.update(
        ClaudeCodeAuth.oauth({
          createQuery: ClaudeCodeQuery.defaultCreateQuery,
          options: { cwd: process.cwd(), pathToClaudeCodeExecutable: resolution.path } as never,
        }) as never,
      )
    })

    const location = yield* Location.Service
    const permission = yield* Permission.Service
    const forms = yield* Form.Service
    const tools = yield* Tool.Service
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    const agentRegistry = yield* Agent.Service

    const cursors = new Map<string, string>()
    const agents = new Map<string, string>()
    const workers = new Set<string>()
    const briefed = new Map<string, string>()
    const profiles = new Map<string, { mode?: string; system?: string }>()
    const pendingOneShot = new Set<string>()
    const substitutionsNotified = new Set<string>()

    let discoveredSnapshot = JSON.stringify(discovered)
    const onDiscovered = (value: unknown) => {
      const models = ClaudeCodeModels.parseDiscovered(value)
      if (!models.length) return
      const snapshot = JSON.stringify(models)
      if (snapshot === discoveredSnapshot) return
      discoveredSnapshot = snapshot
      discovered = models
      Effect.runFork(
        kv
          .set(DISCOVERED_KEY, models.map((entry) => ({ ...entry })))
          .pipe(Effect.andThen(ctx.catalog.reload()), Effect.catch(() => Effect.void)),
      )
    }

    const manager = new ClaudeCodeSessions.SessionManager(ClaudeCodeQuery.defaultCreateQuery, {
      // The picker probe rides the session the user is already spawning; it
      // costs no tokens and no extra process.
      onStart: (query) => void query.supportedModels?.().then(onDiscovered).catch(() => {}),
    })

    const retire = (input: { requested: string; served: string }) => {
      if (!ClaudeCodeModels.isRetirable(input.requested)) return
      if (retired.has(input.requested)) return
      retired.set(input.requested, { served: input.served, at: new Date().toISOString() })
      Effect.runFork(
        kv
          .set(RETIRED_KEY, Object.fromEntries([...retired].map(([id, record]) => [id, { ...record }])))
          .pipe(Effect.andThen(ctx.catalog.reload()), Effect.catch(() => Effect.void)),
      )
    }

    const notifySubstitution = (sessionID: string, input: { requested: string; served: string }) => {
      retire(input)
      const key = `${sessionID} ${input.requested} ${input.served}`
      if (substitutionsNotified.has(key)) return
      substitutionsNotified.add(key)
      // Published on the bus rather than through Session.synthetic: the frame
      // arrives mid-turn, and an inbox-admitted synthetic is steer-delivered
      // into the live turn, spending a model call on the notice itself.
      Effect.runFork(
        bus
          .publish(SessionEvent.Synthetic, {
            sessionID: sessionID as never,
            text: `The requested Claude Code model "${input.requested}" is not available (unknown id, retired, or not on this subscription); Claude Code substituted its default and this turn was answered by "${input.served}".`,
            description: `${input.requested} unavailable — Claude Code answered with ${input.served}`,
            metadata: {
              [ClaudeCodeModels.SUBSTITUTED_METADATA_KEY]: { requested: input.requested, served: input.served },
            },
          })
          .pipe(Effect.catch(() => Effect.void)),
      )
    }

    const mirrors = new Map<string, ClaudeCodeSubagents.Mirror>()
    const mirrorFor = (sessionID: string, model: Model.Ref) => {
      const existing = mirrors.get(sessionID)
      if (existing) return existing
      const mirror = ClaudeCodeSubagents.make({
        parentSessionID: sessionID,
        ops: {
          messageID: () => SessionMessage.ID.create(),
          createChild: (input) =>
            Effect.runPromise(
              sessions
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
        if (ONE_SHOT_AGENTS.has(event.agent)) {
          pendingOneShot.add(event.sessionID)
        } else {
          agents.set(event.sessionID, event.agent)
          const info = yield* agentRegistry.resolve(event.agent).pipe(Effect.orElseSucceed(() => undefined))
          profiles.set(event.agent, { mode: info?.mode, system: info?.system })
          const session = yield* sessions.get(event.sessionID).pipe(Effect.orElseSucceed(() => undefined))
          if (session?.parentID) workers.add(event.sessionID)
        }
        const stored = yield* kv.get(cursorKey(event.sessionID))
        if (typeof stored === "string" && stored) cursors.set(event.sessionID, stored)
      }),
    )

    const turnBrief = (sessionID: string) => {
      const agentID = agents.get(sessionID)
      if (!agentID) return undefined
      const agentChanged = briefed.get(sessionID) !== agentID
      briefed.set(sessionID, agentID)
      const profile = profiles.get(agentID)
      return ClaudeCodeTurnBrief.make({
        agent: { id: agentID, mode: profile?.mode, system: profile?.system },
        isWorker: workers.has(sessionID),
        agentChanged,
      })
    }

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

    const canUseTool = (sessionID: string) =>
      ClaudeCodePermissionBridge.make({
        worktree: location.directory,
        agent: () => agents.get(sessionID),
        assert: (action, resource) =>
          Effect.runPromise(
            permission
              .assert({
                action,
                resources: [resource],
                save: [resource],
                sessionID: sessionID as never,
                ...(agents.get(sessionID) ? { agent: agents.get(sessionID) as never } : {}),
              })
              .pipe(Effect.as({ ok: true as const })),
          ).catch((error) => {
            const feedback = correctionFeedback(error)
            return feedback === undefined ? { ok: false as const } : { ok: false as const, feedback }
          }),
        form: (fields) =>
          Effect.runPromise(
            forms.ask({
              sessionID,
              title: "Questions",
              metadata: { kind: "question", source: "claude-code" },
              fields: fields as never,
            }),
          ).catch(() => undefined),
        exitPlan: () =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* permission.assert({
                action: "plan_exit",
                resources: ["*"],
                sessionID: sessionID as never,
                ...(agents.get(sessionID) ? { agent: agents.get(sessionID) as never } : {}),
              })
              yield* sessions.switchAgent({
                sessionID: sessionID as never,
                agent: Agent.ID.make("build"),
              })
              agents.set(sessionID, "build")
              return true
            }),
          ).catch(() => false),
      })

    const delegate =
      (sessionID: string): ClaudeCodeMcp.Delegate =>
      async (args) => {
        const agent = agents.get(sessionID)
        if (!agent) throw new Error("Task delegation is not available for this session.")
        return Effect.runPromise(
          Effect.gen(function* () {
            const snapshot = yield* tools.snapshot()
            const messages = yield* sessions.messages({ sessionID: sessionID as never, order: "desc", limit: 1 })
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
            Effect.mapError((error) =>
              error instanceof Error ? error : new Error(String((error as { message?: string })?.message ?? error)),
            ),
          ),
        )
      }

    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (event) {
        if (event.model.providerID !== ClaudeCodeModels.PROVIDER_ID) return
        event.sdk = {
          languageModel: () => {
            throw new Error(`${ClaudeCodeModels.SENTINEL_NAME} has no SDK model; the language hook must supply it.`)
          },
        }
      }),
    )

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
            isOneShot: (sessionID) => pendingOneShot.delete(sessionID),
            turnBrief,
            taskChildren: (sessionID) => mirrorFor(sessionID, modelRef).children(),
            observer: (sessionID, message, inTurn) => mirrorFor(sessionID, modelRef).observe(message, inTurn),
            onTurnEnd: (sessionID) => mirrors.get(sessionID)?.sweep(),
            onExit: (sessionID) => mirrors.get(sessionID)?.finalize(),
            onModelSubstituted: notifySubstitution,
            resolvedModel: (id) => discovered.find((entry) => entry.value === id)?.resolvedModel,
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
