export * as ClaudeCodeProviderPlugin from "./provider.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Model } from "@opencode/schema/model"
import { Agent } from "../../../agent.js"
import { Bus } from "../../../bus.js"
import { Permission } from "../../../permission.js"
import type { ConfigClaudeCode } from "@opencode/schema/config/claude-code"
import { Session } from "../../../session.js"
import { SessionEvent } from "../../../session/event.js"
import { SessionMessage } from "../../../session/message.js"
import { Skill } from "../../../skill.js"
import type { Tool as ToolSchema } from "@opencode/schema/tool"
import { ClaudeCodeAuth } from "./auth.js"
import { ClaudeCodeExecutable } from "./executable.js"
import { ClaudeCodeLanguageModel } from "./language-model.js"
import { ClaudeCodeMcp } from "./mcp.js"
import { ClaudeCodeHostTools } from "./host-tools.js"
import { ClaudeCodeModes } from "./modes.js"
import { ClaudeCodeModels } from "./models.js"
import { ClaudeCodePolicyHooks } from "./policy-hooks.js"
import { ClaudeCodeQuery } from "./query.js"
import { ClaudeCodeQuestions } from "./questions.js"
import { ClaudeCodeSessions } from "./sessions.js"
import { ClaudeCodeSubagentEvents } from "./subagent-events.js"
import { ClaudeCodeSubagents } from "./subagents.js"
import { ClaudeCodeContext } from "./context.js"
import { InstructionDiscovery } from "../../../instruction-discovery.js"
import { RedsunContextOptimizer } from "../context-optimizer.js"
import { ClaudeCodeHostFiles } from "./host-files.js"
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"
import type { DelegatedCodeMode, DelegatedTurn } from "@opencode/plugin/effect/delegate"

const ONE_SHOT_AGENTS = new Set(["title", "summary", "compaction"])

// Every non-primary request kind is one-shot already; these agents also run one-shot when a
// plugin sends them as a primary request.
const isOneShot = (turn: DelegatedTurn) => turn.kind !== "primary" || ONE_SHOT_AGENTS.has(turn.agent)

// Storage keys under the runtime prefix `redsun.claude-code`, unchanged from when the plugin
// wrote raw KV, so existing cursors and caches carry over.
const RUNTIME_ID = "claude-code"
const cursorKey = (sessionID: string) => `-session/${sessionID}`
const RETIRED_KEY = ".retired"
const DISCOVERED_KEY = ".discovered"

export const Plugin = define({
  id: "redsun.provider.claude-code",
  effect: Effect.fn(function* (ctx) {
    const settings = (yield* ctx.delegate.config("claude_code")) as ConfigClaudeCode.Info | undefined
    if (settings?.enabled === false) return

    const resolution = ClaudeCodeExecutable.resolve(settings?.binary_path)
    if ("error" in resolution) {
      yield* Effect.logDebug("claude code provider unavailable", { reason: resolution.error })
      return
    }

    const kv = ctx.delegate.storage(RUNTIME_ID)
    const location = ctx.location
    const resolveAgent = (agentID: string) =>
      ctx.agent.get({ agentID: Agent.ID.make(agentID) }).pipe(
        Effect.map((result) => result.data),
        Effect.orElseSucceed(() => undefined),
      )

    // The registry keeps itself fresh through two KV-backed inputs re-applied
    // on every catalog reload: pinned ids the CLI was observed substituting
    // (hidden until config resurrects them) and the CLI's own picker rows
    // (probed at startup and refreshed on spawned sessions).
    const retired = ClaudeCodeModels.parseRetired(
      yield* kv.get(RETIRED_KEY).pipe(Effect.orElseSucceed(() => undefined)),
    )
    let discovered = ClaudeCodeModels.parseDiscovered(
      yield* kv.get(DISCOVERED_KEY).pipe(Effect.orElseSucceed(() => undefined)),
    )
    const hadCache = discovered.length > 0

    // The idle SDK query initializes the picker without a model request, but
    // would otherwise fire SessionStart, launch inherited MCP, and persist a
    // native session. Keep the real setting sources/cwd for model resolution.
    const probeOptions = ClaudeCodeModels.metadataOptions({
      cwd: location.directory,
      pathToClaudeCodeExecutable: resolution.path,
      ...(settings?.config_dir || settings?.env
        ? {
            env: {
              ...process.env,
              ...settings?.env,
              ...(settings?.config_dir ? { CLAUDE_CONFIG_DIR: settings.config_dir } : {}),
            },
          }
        : {}),
      ...(settings?.extra_args
        ? {
            extraArgs: Array.isArray(settings.extra_args)
              ? Object.fromEntries(settings.extra_args.map((flag) => [flag, null]))
              : settings.extra_args,
          }
        : {}),
    })
    const probe = (signal: AbortSignal) =>
      ClaudeCodeModels.probe(ClaudeCodeQuery.defaultCreateQuery, probeOptions, 5_000, signal)
    // No cache: wait briefly for an accurate first picker. With cached rows,
    // register immediately and refresh in a scope-bound background fiber.
    if (!discovered.length) {
      const initial = yield* Effect.tryPromise(probe).pipe(
        Effect.orElseSucceed(() => [] as ClaudeCodeModels.Discovered[]),
      )
      if (initial.length) {
        discovered = initial
        yield* kv
          .set(
            DISCOVERED_KEY,
            initial.map((entry) => ({ ...entry })),
          )
          .pipe(Effect.catch(() => Effect.void))
      }
    }

    yield* ctx.provider.transform((draft) => ClaudeCodeModels.applyCatalog(draft, { retired, discovered }))

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

    const permission = ctx.delegate.permission
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    const agentRegistry = yield* Agent.Service
    const discovery = yield* InstructionDiscovery.Service
    const skills = yield* Skill.Service

    const cursors = new Map<string, string>()
    const agents = new Map<string, string>()
    const workers = new Set<string>()
    const context = new ClaudeCodeContext.Tracker()
    const compactRestored = new Map<string, number>()
    const profiles = new Map<string, { mode?: string; system?: string }>()
    const substitutionsNotified = new Set<string>()
    const runtimes = new Map<
      string,
      {
        policy: ReturnType<typeof ClaudeCodePolicyHooks.make>
        server: ReturnType<typeof ClaudeCodeMcp.makeHostServer>
        binding?: ReturnType<typeof ClaudeCodeMcp.fromBinding> & { directNames: ReadonlySet<string> }
        codeMode?: DelegatedCodeMode | null
        catalog: string
        results: Map<string, ToolSchema.Metadata>
        submission?: ReturnType<ClaudeCodeContext.Tracker["prepare"]>
      }
    >()

    let discoveredSnapshot = JSON.stringify(discovered)
    let discoveryEpoch = 0
    const onDiscovered = (value: unknown) => {
      const models = ClaudeCodeModels.parseDiscovered(value)
      if (!models.length) return
      const snapshot = JSON.stringify(models)
      if (snapshot === discoveredSnapshot) return
      discoveryEpoch++
      discoveredSnapshot = snapshot
      discovered = models
      Effect.runFork(
        kv
          .set(
            DISCOVERED_KEY,
            models.map((entry) => ({ ...entry })),
          )
          .pipe(
            Effect.andThen(ctx.provider.reload()),
            Effect.catch(() => Effect.void),
          ),
      )
    }
    if (hadCache) {
      const epoch = discoveryEpoch
      yield* Effect.tryPromise(probe).pipe(
        Effect.tap((rows) =>
          Effect.sync(() => {
            if (discoveryEpoch === epoch) onDiscovered(rows)
          }),
        ),
        Effect.catch(() => Effect.void),
        Effect.forkScoped({ startImmediately: true }),
      )
    }

    const manager = new ClaudeCodeSessions.SessionManager(ClaudeCodeQuery.defaultCreateQuery, {
      // The picker probe rides the session the user is already spawning; it
      // costs no tokens and no extra process.
      onStart: (query) =>
        void query
          .supportedModels?.()
          .then(onDiscovered)
          .catch(() => {}),
    })

    const retire = (input: { requested: string; served: string }) => {
      if (!ClaudeCodeModels.isRetirable(input.requested)) return
      if (retired.has(input.requested)) return
      retired.set(input.requested, { served: input.served, at: new Date().toISOString() })
      Effect.runFork(
        kv.set(RETIRED_KEY, Object.fromEntries([...retired].map(([id, record]) => [id, { ...record }]))).pipe(
          Effect.andThen(ctx.provider.reload()),
          Effect.catch(() => Effect.void),
        ),
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

    // Turn identity arrives typed from core; capture what the SDK callbacks read per session.
    const beginTurn = async (turn: DelegatedTurn) => {
      if (!isOneShot(turn)) {
        agents.set(turn.sessionID, turn.agent)
        const info = await Effect.runPromise(resolveAgent(turn.agent))
        profiles.set(turn.agent, { mode: info?.mode, system: info?.system })
        if (turn.parentID) workers.add(turn.sessionID)
      }
      const stored = await Effect.runPromise(
        kv.get(cursorKey(turn.sessionID)).pipe(Effect.orElseSucceed(() => undefined)),
      )
      if (typeof stored === "string" && stored) cursors.set(turn.sessionID, stored)
    }

    const turnContext = async (sessionID: string, freshProcess: boolean, current: () => boolean = () => true) => {
      const agentID = agents.get(sessionID)
      if (!agentID) return { delivered: () => {} }
      const profile = profiles.get(agentID)
      const listed = settings?.behavior === "native" ? undefined : await Effect.runPromise(discovery.list())
      // Read at delivery time so an instruction_max_chars edit applies to the next turn.
      const configured = await Effect.runPromise(ctx.delegate.config("instruction_max_chars"))
      const maxChars = typeof configured === "number" ? configured : RedsunContextOptimizer.INSTRUCTION_MAX_CHARS
      const runtime = runtimes.get(sessionID)
      const hasSkillTool =
        settings?.behavior !== "native" && runtime?.binding?.definitions.some((item) => item.name === "skill")
      const catalog = hasSkillTool
        ? await (async () => {
            const agent = await Effect.runPromise(agentRegistry.resolve(agentID))
            if (!agent) return []
            const candidates = Skill.available(await Effect.runPromise(skills.list()), agent).filter(
              (skill) => skill.description !== undefined && skill.autoinvoke !== false,
            )
            const allowed = await Promise.all(
              candidates.map(async (skill) => ({
                skill,
                result: await Effect.runPromise(
                  permission.inspect({
                    action: "skill",
                    resources: [skill.id],
                    sessionID,
                    agent: agentID,
                  }),
                ),
              })),
            )
            return allowed
              .filter(({ result }) => result.effect !== "deny")
              .map(({ skill }) => ({ id: skill.id, name: skill.name, description: skill.description! }))
          })()
        : settings?.behavior === "native"
          ? undefined
          : []
      const codeMode = runtime?.codeMode
      // Discovery's unavailable result is not an observed removal: keep the last
      // successfully delivered project rules until the canonical source recovers.
      return ClaudeCodeContext.commitIfCurrent(current, () => {
        const delivery = context.prepare(sessionID, {
          agent: { id: agentID, mode: profile?.mode, system: profile?.system },
          isWorker: workers.has(sessionID),
          freshProcess,
          ...(catalog === undefined ? {} : { skills: catalog }),
          ...(codeMode === undefined ? {} : { codeMode }),
          ...(Array.isArray(listed)
            ? { files: ClaudeCodeHostFiles.deliver(listed, { project: location.project.directory, maxChars }) }
            : {}),
        })
        if (runtime) runtime.submission = delivery
        return delivery
      })
    }

    // The callback is registered at process startup but reads the current turn's
    // captured delivery. Do not inspect or reinterpret the user prompt here.
    const userPromptSubmit = (sessionID: string) => ClaudeCodeContext.submit(() => runtimes.get(sessionID)?.submission)
    const sessionStart = (sessionID: string) =>
      ClaudeCodeContext.compactForTurn(
        runtimes.get(sessionID),
        () => runtimes.get(sessionID),
        (current) => turnContext(sessionID, true, current),
        () => compactRestored.set(sessionID, (compactRestored.get(sessionID) ?? 0) + 1),
      )

    const permissionMode = async (sessionID: string) => {
      const agentID = agents.get(sessionID)
      const info = agentID ? await Effect.runPromise(resolveAgent(agentID)) : undefined
      return ClaudeCodeModes.permissionMode({
        agentID,
        agentMode: info?.mode,
        isWorker: workers.has(sessionID),
        global: await Effect.runPromise(permission.mode()),
        configured: settings?.permission_mode,
        worker: settings?.worker_permission_mode,
      })
    }

    const policyFor = (sessionID: string) =>
      ClaudeCodePolicyHooks.make({
        worktree: location.directory,
        agent: () => agents.get(sessionID),
        isDirectHostTool: (name) => runtimes.get(sessionID)?.binding?.directNames.has(name) === true,
        policy: (action, resource, signal) =>
          Effect.runPromise(
            permission.inspect({
              action,
              resources: [resource],
              sessionID,
              ...(agents.get(sessionID) ? { agent: agents.get(sessionID)! } : {}),
            }),
            { signal },
          ),
        assert: (action, resource, signal) =>
          Effect.runPromise(
            permission.assert({
              action,
              resources: [resource],
              save: [resource],
              sessionID,
              ...(agents.get(sessionID) ? { agent: agents.get(sessionID)! } : {}),
            }),
            { signal },
          ).catch(() => ({ ok: false as const })),
        form: (fields, signal) =>
          Effect.runPromise(
            ctx.delegate.form.ask({
              sessionID,
              title: "Questions",
              metadata: { kind: "question", source: "claude-code" },
              fields: fields as never,
            }),
            { signal },
          ).catch(() => undefined),
        exitPlan: (signal) =>
          Effect.runPromise(
            permission.assert({
              action: "plan_exit",
              resources: ["*"],
              sessionID,
              ...(agents.get(sessionID) ? { agent: agents.get(sessionID)! } : {}),
            }),
            { signal },
          ).then(
            (approval) => approval.ok,
            () => false,
          ),
        commitPlanExit: async (signal) => {
          await Effect.runPromise(ctx.session.switchAgent({ sessionID: sessionID as never, agent: "build" as never }), {
            signal,
          })
          agents.set(sessionID, "build")
        },
      })

    const prepareTurn = async (
      sessionID: string,
      messageID: string,
      signal: AbortSignal,
      mode: PermissionMode,
      availableTools: readonly string[],
    ) => {
      if (!messageID) throw new Error("Claude Code turn is missing its assistant message ID for host tool attribution.")
      if (signal.aborted) throw new Error("Claude Code turn was cancelled before host tools were bound.")
      const agentID = agents.get(sessionID)
      if (!agentID) throw new Error("Claude Code turn has no active session or agent.")
      if (manager.busy(sessionID)) throw new Error("Claude Code session is already processing a turn")
      const bound = await Effect.runPromise(ctx.delegate.tools.bind({ sessionID, agent: agentID, messageID }), {
        signal,
      })
      if (signal.aborted) throw new Error("Claude Code turn was cancelled before host tools were bound.")
      const definitions = ClaudeCodeHostTools.select({
        definitions: bound.definitions,
        available: availableTools,
        direct: bound.direct,
        behavior: settings?.behavior,
      })
      const allowed = new Set(definitions.map((item) => item.name))
      const captured = ClaudeCodeMcp.fromBinding({
        binding: bound,
        messageID,
        allowed,
        onResult: ({ nativeToolUseID, result }) => {
          const active = runtimes.get(sessionID)
          if (nativeToolUseID && result.metadata && active?.binding === binding)
            active.results.set(nativeToolUseID, result.metadata)
        },
      })
      const binding = {
        ...captured,
        definitions,
        directNames: new Set(
          [...bound.direct].filter((name) => allowed.has(name)).map((name) => `mcp__redsun__${name}`),
        ),
      }
      const catalog = ClaudeCodeHostTools.discoveryKey(definitions)
      let runtime = runtimes.get(sessionID)
      if (runtime && runtime.catalog !== catalog && !manager.busy(sessionID)) {
        manager.stop(sessionID) // The SDK does not update an existing MCP tool catalog.
        runtime.policy.clear()
        runtimes.delete(sessionID)
        runtime = undefined
      }
      if (!runtime || manager.willStart(sessionID, mode)) {
        runtime?.policy.clear()
        const policy = policyFor(sessionID)
        const next = {
          policy,
          server: undefined as unknown as ReturnType<typeof ClaudeCodeMcp.makeHostServer>,
          binding: undefined as typeof binding | undefined,
          codeMode: undefined as DelegatedCodeMode | null | undefined,
          catalog,
          results: new Map<string, ToolSchema.Metadata>(),
          submission: undefined as ReturnType<ClaudeCodeContext.Tracker["prepare"]> | undefined,
        }
        next.server = ClaudeCodeMcp.makeHostServer(() => next.binding)
        runtime = next
        runtimes.set(sessionID, runtime)
      }
      runtime.binding = binding // Bind before the CLI's initial tools/list.
      runtime.codeMode = allowed.has("execute") && bound.codeMode ? bound.codeMode : null
      return () => {
        if (runtime.binding === binding) runtime.binding = undefined
        runtime.results.clear()
        runtime.submission = undefined
        runtime.policy.clear()
      }
    }

    const models = new Map<string, ClaudeCodeLanguageModel.Model>()
    const modelFor = (modelID: string) => {
      const existing = models.get(modelID)
      if (existing) return existing
      const modelRef = Model.Ref.make({ providerID: ClaudeCodeModels.PROVIDER_ID, id: Model.ID.make(modelID) })
      const created = ClaudeCodeLanguageModel.make({
        modelID,
        config: {
          executablePath: resolution.path,
          cwd: location.directory,
          permissionMode: settings?.permission_mode,
          configDir: settings?.config_dir,
          extraArgs: settings?.extra_args,
          env: settings?.env,
          behavior: settings?.behavior,
        },
        manager,
        createQuery: ClaudeCodeQuery.defaultCreateQuery,
        hooks: {
          prepareTurn,
          canUseTool: (sessionID) => runtimes.get(sessionID)?.policy.canUseTool,
          preToolUse: (sessionID) => runtimes.get(sessionID)?.policy.preToolUse,
          postToolUse: (sessionID) => runtimes.get(sessionID)?.policy.postToolUse,
          isDirectHostTool: (sessionID, name) => runtimes.get(sessionID)?.binding?.directNames.has(name) === true,
          hostResultMetadata: (sessionID, id) => {
            const result = runtimes.get(sessionID)?.results.get(id)
            runtimes.get(sessionID)?.results.delete(id)
            return result
          },
          turnOptions: (sessionID) => ({
            mcpServers: { redsun: runtimes.get(sessionID)!.server },
          }),
          isOneShot,
          context: async (sessionID, freshProcess) => (await turnContext(sessionID, freshProcess))!,
          userPromptSubmit,
          sessionStart,
          compactRestored: (sessionID) => compactRestored.get(sessionID) ?? 0,
          taskChildren: (sessionID) => mirrorFor(sessionID, modelRef).children(),
          observer: (sessionID, message, inTurn) => mirrorFor(sessionID, modelRef).observe(message, inTurn),
          turnPending: (sessionID) => mirrors.get(sessionID)?.continuation() ?? "none",
          onTurnEnd: (sessionID) => mirrors.get(sessionID)?.sweep(),
          onCompacted: (sessionID) => context.clear(sessionID),
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
      models.set(modelID, created)
      return created
    }

    yield* ctx.delegate.register({
      id: "claude-code",
      providerID: ClaudeCodeModels.PROVIDER_ID,
      turn: async (turn, options) => {
        await beginTurn(turn)
        return modelFor(turn.modelID).stream(turn, options)
      },
      compaction: {
        notice: "Claude Code compacts its own session; running /compact in the CLI instead.",
        command: "/compact",
      },
    })

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        manager.stopAll()
        for (const runtime of runtimes.values()) runtime.policy.clear()
        runtimes.clear()
        mirrors.clear()
      }),
    )
  }),
})
