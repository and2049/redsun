export * as ClaudeCodeProviderPlugin from "./provider.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import path from "node:path"
import { Model } from "@opencode/schema/model"
import { Agent } from "../../../agent.js"
import { Bus } from "../../../bus.js"
import { Config } from "../../../config.js"
import { Form } from "../../../form.js"
import { KV } from "../../../kv.js"
import { Location } from "../../../location.js"
import { Mcp } from "../../../mcp/index.js"
import { Permission } from "../../../permission.js"
import { Session } from "../../../session.js"
import { SessionEvent } from "../../../session/event.js"
import { SessionMessage } from "../../../session/message.js"
import { Skill } from "../../../skill.js"
import { Tool } from "../../../tool.js"
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
import { CodeModeCatalog } from "../../../codemode/catalog.js"
import { InstructionDiscovery } from "../../../instruction-discovery.js"
import { RedsunProjectMemory } from "../project-memory.js"
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"

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
    const location = yield* Location.Service

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

    const permission = yield* Permission.Service
    const forms = yield* Form.Service
    const tools = yield* Tool.Service
    const mcp = yield* Mcp.Service
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
    const pendingOneShot = new Set<string>()
    const substitutionsNotified = new Set<string>()
    const runtimes = new Map<
      string,
      {
        policy: ReturnType<typeof ClaudeCodePolicyHooks.make>
        server: ReturnType<typeof ClaudeCodeMcp.makeHostServer>
        binding?: ReturnType<typeof ClaudeCodeMcp.fromSnapshot> & { directNames: ReadonlySet<string> }
        codeMode?: CodeModeCatalog.Summary | null
        catalog: string
        results: Map<string, Tool.Metadata>
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

    const turnContext = async (sessionID: string, freshProcess: boolean, current: () => boolean = () => true) => {
      const agentID = agents.get(sessionID)
      if (!agentID) return { delivered: () => {} }
      const profile = profiles.get(agentID)
      const listed = settings?.behavior === "native" ? undefined : await Effect.runPromise(discovery.list())
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
                    sessionID: sessionID as never,
                    agent: Agent.ID.make(agentID),
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
            ? {
                files: listed.map((file) => ({
                  path: file.path,
                  content:
                    file.path === path.join(location.project.directory, RedsunProjectMemory.RELATIVE_PATH)
                      ? `${RedsunProjectMemory.POLICY}\n\n${file.content}`
                      : file.content,
                })),
              }
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
      const info = agentID ? await Effect.runPromise(agentRegistry.resolve(agentID)).catch(() => undefined) : undefined
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
              sessionID: sessionID as never,
              ...(agents.get(sessionID) ? { agent: Agent.ID.make(agents.get(sessionID)!) } : {}),
            }),
            { signal },
          ),
        assert: (action, resource, signal) =>
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
            { signal },
          ).catch((error) => {
            const feedback = correctionFeedback(error)
            return feedback === undefined ? { ok: false as const } : { ok: false as const, feedback }
          }),
        form: (fields, signal) =>
          Effect.runPromise(
            forms.ask({
              sessionID,
              title: "Questions",
              metadata: { kind: "question", source: "claude-code" },
              fields: fields as never,
            }),
            { signal },
          ).catch(() => undefined),
        exitPlan: (signal) =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* permission.assert({
                action: "plan_exit",
                resources: ["*"],
                sessionID: sessionID as never,
                ...(agents.get(sessionID) ? { agent: agents.get(sessionID) as never } : {}),
              })
              return true
            }),
            { signal },
          ).catch(() => false),
        commitPlanExit: async (signal) => {
          await Effect.runPromise(
            sessions.switchAgent({ sessionID: sessionID as never, agent: Agent.ID.make("build") }),
            { signal },
          )
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
      const session = await Effect.runPromise(sessions.get(sessionID as never), { signal })
      const agentID = agents.get(sessionID)
      if (!session || !agentID) throw new Error("Claude Code turn has no active session or agent.")
      if (manager.busy(sessionID)) throw new Error("Claude Code session is already processing a turn")
      const agent = Agent.ID.make(agentID)
      const info = await Effect.runPromise(agentRegistry.resolve(agentID), { signal })
      if (!info) throw new Error(`Claude Code agent is no longer available: ${agentID}`)
      const snapshot = await Effect.runPromise(
        tools.snapshot(Permission.merge(info.permissions, session.permissions ?? [])),
        { signal },
      )
      const connected = await Effect.runPromise(mcp.tools(), { signal })
      if (signal.aborted) throw new Error("Claude Code turn was cancelled before host tools were bound.")
      const definitions = ClaudeCodeHostTools.select({
        definitions: snapshot.definitions,
        available: availableTools,
        direct: ClaudeCodeHostTools.directNames(connected),
        behavior: settings?.behavior,
      })
      const allowed = new Set(definitions.map((item) => item.name))
      const captured = ClaudeCodeMcp.fromSnapshot({
        snapshot,
        sessionID: session.id,
        agent,
        messageID: SessionMessage.ID.make(messageID),
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
          [...ClaudeCodeHostTools.directNames(connected)]
            .filter((name) => allowed.has(name))
            .map((name) => `mcp__redsun__${name}`),
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
          codeMode: undefined as CodeModeCatalog.Summary | null | undefined,
          catalog,
          results: new Map<string, Tool.Metadata>(),
          submission: undefined as ReturnType<ClaudeCodeContext.Tracker["prepare"]> | undefined,
        }
        next.server = ClaudeCodeMcp.makeHostServer(() => next.binding)
        runtime = next
        runtimes.set(sessionID, runtime)
      }
      runtime.binding = binding // Bind before the CLI's initial tools/list.
      runtime.codeMode =
        allowed.has("execute") && snapshot.codeModeCatalog ? CodeModeCatalog.summarize(snapshot.codeModeCatalog) : null
      return () => {
        if (runtime.binding === binding) runtime.binding = undefined
        runtime.results.clear()
        runtime.submission = undefined
        runtime.policy.clear()
      }
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
            isOneShot: (sessionID) => pendingOneShot.delete(sessionID),
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
      }),
    )

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
