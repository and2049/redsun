import { describe, expect } from "bun:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import type { DelegatedRuntime as Runtime, DelegatedTurn } from "@opencode/plugin/effect/delegate"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Agent as AgentService } from "@opencode/core/agent"
import { AISDK } from "@opencode/core/aisdk"
import { Bus } from "@opencode/core/bus"
import { Form } from "@opencode/core/form"
import { KV } from "@opencode/core/kv"
import { Skill } from "@opencode/core/skill"
import { Permission } from "@opencode/core/permission"
import { DelegatedRuntime } from "@opencode/core/delegate"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { QuestionTool } from "@opencode/core/tool/plugin/question"
import { Context, DateTime, Deferred, Effect, Fiber, Scope } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"
import { registerToolPlugin } from "./lib/tool"

// REDSUN: the delegated runtime seam. A runtime registers through the real plugin host; core tags
// its requests in `prepare`, routes its models through the AI SDK bridge ahead of any SDK hook,
// and hands the runtime a typed turn with the internal headers removed.

const it = testEffect(PluginTestLayer)

const OWNED = "delegated-agent"

const session = (parentID?: string) =>
  Session.Info.make({
    id: Session.ID.make("ses_delegate"),
    projectID: Project.ID.global,
    ...(parentID ? { parentID: Session.ID.make(parentID) } : {}),
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
  })

const resolved = (provider: string) =>
  SessionRunnerModel.resolved(LanguageModel.make({ id: "model-1", provider, route: OpenAIChat.route }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })

const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

const catalogModel = (providerID: string) =>
  Model.Info.make({
    ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make("model-1")),
    // Not a real npm package: core must never try to load it for an owned provider.
    package: Provider.aisdk("@example/not-installed"),
  })

const runtime = (turns: Array<{ turn: DelegatedTurn; options: LanguageModelV3CallOptions }>): Runtime => ({
  id: "fake",
  providerID: OWNED,
  turn: async (turn, options) => {
    turns.push({ turn, options })
    return { stream: new ReadableStream({ start: (controller) => controller.close() }) }
  },
})

const register = (value: Runtime) =>
  Effect.gen(function* () {
    const host = yield* PluginHost.make(yield* Plugin.Service)
    return yield* host.delegate.register(value)
  })

const prepare = (provider: string, kind: "primary" | "title", parentID?: string) =>
  Effect.gen(function* () {
    const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
    return yield* requests[kind]({
      session: session(parentID),
      agent: Agent.ID.make("build"),
      model: resolved(provider),
      system: [],
      messages: [],
    })
  }).pipe(Effect.provideService(SessionModelTransport.Service, transport))

describe("DelegatedRuntime.decode", () => {
  it.effect("reads the turn identity and strips only the internal headers", () =>
    Effect.sync(() => {
      const decoded = DelegatedRuntime.decode("model-1", {
        prompt: [],
        headers: {
          "x-opencode-session": "ses_1",
          "x-parent-session-id": "ses_parent",
          "X-Redsun-Delegate-Agent": "build",
          "x-redsun-delegate-kind": "primary",
          "x-redsun-delegate-message": "msg_1",
          "x-opencode-client": "redsun",
        },
      })
      expect(decoded.turn).toEqual({
        sessionID: "ses_1",
        parentID: "ses_parent",
        agent: "build",
        kind: "primary",
        modelID: "model-1",
        assistantMessageID: "msg_1",
      })
      expect(decoded.options.headers).toEqual({
        "x-opencode-session": "ses_1",
        "x-parent-session-id": "ses_parent",
        "x-opencode-client": "redsun",
      })
    }),
  )

  it.effect("yields no turn without a complete, known identity", () =>
    Effect.sync(() => {
      const partial = { "x-opencode-session": "ses_1", "x-redsun-delegate-agent": "build" }
      expect(DelegatedRuntime.decode("m", { prompt: [], headers: partial }).turn).toBeUndefined()
      const unknown = { ...partial, "x-redsun-delegate-kind": "bogus" }
      expect(DelegatedRuntime.decode("m", { prompt: [], headers: unknown }).turn).toBeUndefined()
      expect(DelegatedRuntime.decode("m", { prompt: [] }).turn).toBeUndefined()
    }),
  )
})

describe("delegated runtime registration", () => {
  it.effect("tags only the owned provider's requests, for every kind", () =>
    Effect.gen(function* () {
      yield* register(runtime([]))
      const owned = yield* prepare(OWNED, "primary", "ses_parent")
      expect(owned.request.http?.headers).toMatchObject({
        "x-opencode-session": "ses_delegate",
        "x-parent-session-id": "ses_parent",
        "x-redsun-delegate-agent": "build",
        "x-redsun-delegate-kind": "primary",
      })
      const title = yield* prepare(OWNED, "title")
      expect(title.request.http?.headers).toMatchObject({ "x-redsun-delegate-kind": "title" })
      const other = yield* prepare("other-provider", "primary")
      expect(Object.keys(other.request.http?.headers ?? {}).some((key) => key.startsWith("x-redsun-delegate"))).toBe(
        false,
      )
    }),
  )

  it.effect("routes an owned model to the runtime ahead of SDK hooks with a typed turn", () =>
    Effect.gen(function* () {
      const turns: Array<{ turn: DelegatedTurn; options: LanguageModelV3CallOptions }> = []
      yield* register(runtime(turns))
      const aisdk = yield* AISDK.Service
      const sdkHooks: string[] = []
      yield* aisdk.hook.sdk((event) => {
        sdkHooks.push(event.model.providerID)
      })

      const prepared = yield* prepare(OWNED, "primary")
      const language = yield* aisdk.language(catalogModel(OWNED))
      yield* Effect.promise(() =>
        language.doStream({
          prompt: [],
          headers: { ...prepared.request.http?.headers, "x-redsun-delegate-message": "msg_step" },
        }),
      )

      expect(sdkHooks).toEqual([])
      expect(turns).toHaveLength(1)
      expect(turns[0]!.turn).toEqual({
        sessionID: "ses_delegate",
        agent: "build",
        kind: "primary",
        modelID: "model-1",
        assistantMessageID: "msg_step",
      })
      expect(Object.keys(turns[0]!.options.headers ?? {}).some((key) => key.startsWith("x-redsun-delegate"))).toBe(
        false,
      )
    }),
  )

  it.effect("rejects a request that carries no turn identity instead of guessing", () =>
    Effect.gen(function* () {
      yield* register(runtime([]))
      const aisdk = yield* AISDK.Service
      const language = yield* aisdk.language(catalogModel(OWNED))
      const outcome = yield* Effect.promise(() =>
        language.doStream({ prompt: [], headers: { "x-opencode-client": "redsun" } }).then(
          () => "streamed",
          (error: Error) => error.message,
        ),
      )
      expect(outcome).toContain("requires a session request; this request carried no turn identity")
    }),
  )

  it.effect("offers native approval only where the runtime declares it", () =>
    Effect.gen(function* () {
      const delegates = yield* DelegatedRuntime.Service
      yield* register({ ...runtime([]), nativeApproval: (model) => model.id !== "no-classifier" })
      yield* register({ ...runtime([]), id: "plain", providerID: "plain-agent" })
      expect(yield* delegates.nativeApproval({ providerID: OWNED, id: "model-1" })).toBe(true)
      expect(yield* delegates.nativeApproval({ providerID: OWNED, id: "no-classifier" })).toBe(false)
      expect(yield* delegates.nativeApproval({ providerID: "plain-agent", id: "model-1" })).toBe(false)
      expect(yield* delegates.nativeApproval({ providerID: "not-delegated", id: "model-1" })).toBe(false)
    }),
  )

  it.effect("stops owning the provider when the registration scope closes", () =>
    Effect.gen(function* () {
      const delegates = yield* DelegatedRuntime.Service
      const scope = yield* Scope.make()
      yield* register(runtime([])).pipe(Scope.provide(scope))
      expect(yield* delegates.owns({ providerID: OWNED })).toBe(true)
      yield* Scope.close(scope, { _tag: "Success", value: undefined } as never)
      expect(yield* delegates.owns({ providerID: OWNED })).toBe(false)
      const untagged = yield* prepare(OWNED, "primary")
      expect(untagged.request.http?.headers?.["x-redsun-delegate-kind"]).toBeUndefined()
    }),
  )
})

describe("delegated runtime host capabilities", () => {
  const hostWith = (permission: Partial<Permission.Interface>) =>
    Effect.gen(function* () {
      const base = yield* Permission.Service
      const plugin = yield* Plugin.Service
      return yield* PluginHost.make(plugin).pipe(
        Effect.provideService(Permission.Service, Permission.Service.of({ ...base, ...permission })),
      )
    })

  it.effect("keeps runtime storage under the stable redsun.<id> prefix", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* Plugin.Service)
      const storage = host.delegate.storage("fake-agent")
      yield* storage.set("-session/ses_1", "cursor_1")
      expect(yield* (yield* KV.Service).get("redsun.fake-agent-session/ses_1")).toBe("cursor_1")
      expect(yield* storage.get("-session/ses_1")).toBe("cursor_1")
      yield* storage.remove("-session/ses_1")
      expect(yield* storage.get("-session/ses_1")).toBeUndefined()
    }),
  )

  it.effect("reports approvals, declines and corrections as data", () =>
    Effect.gen(function* () {
      const input = { sessionID: "ses_1", agent: "build", action: "edit", resources: ["src/a.ts"] }
      const approved = yield* hostWith({ assert: () => Effect.void })
      expect(yield* approved.delegate.permission.assert(input)).toEqual({ ok: true })

      const declined = yield* hostWith({ assert: () => Effect.die(new Permission.DeclinedError()) })
      expect(yield* declined.delegate.permission.assert(input)).toEqual({ ok: false })

      const corrected = yield* hostWith({
        assert: () => Effect.fail(new Permission.CorrectedError({ feedback: "use b.ts" })),
      })
      expect(yield* corrected.delegate.permission.assert(input)).toEqual({ ok: false, feedback: "use b.ts" })
    }),
  )

  // REDSUN: a runtime calls back from its own process boundary (SDK callback, MCP request) on a
  // fiber with no ambient Location. The TUI keeps a session form only when its event carries the
  // location, so the host must envelope it as it is when a native tool runs inside the turn.
  const formCreated = Effect.gen(function* () {
    const bus = yield* Bus.Service
    const created = yield* Deferred.make<{ readonly form: Form.Info; readonly location?: Location.Ref }>()
    const unsubscribe = yield* bus.listen((event) =>
      event.type === Form.Event.Created.type
        ? Deferred.succeed(created, {
            form: (event.data as { readonly form: Form.Info }).form,
            ...(event.location ? { location: event.location } : {}),
          }).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return created
  })

  it.effect("envelopes a form a runtime asks from a bare fiber with the host location", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* Plugin.Service)
      const forms = yield* Form.Service
      const location = yield* Location.Service
      const created = yield* formCreated
      const fiber = yield* host.delegate.form
        .ask({
          sessionID: "ses_1",
          title: "Questions",
          fields: [
            { key: "q0", title: "Continue?", type: "string", options: [{ value: "yes", label: "Yes" }] },
          ] as never,
        })
        .pipe(
          Effect.updateContext((context: Context.Context<never>) => Context.omit(Location.Service)(context)),
          Effect.forkScoped,
        )
      const event = yield* Deferred.await(created)
      expect(event.form.sessionID).toBe("ses_1")
      expect(event.location).toEqual({ directory: location.directory, workspaceID: location.workspaceID })
      yield* forms.reply({ id: event.form.id, answer: { q0: "yes" } })
      expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answer: { q0: "yes" } })
    }),
  )

  it.effect("envelopes a form a bound host tool asks from a bare fiber with the host location", () =>
    Effect.gen(function* () {
      yield* registerToolPlugin(QuestionTool.Plugin)
      const host = yield* PluginHost.make(yield* Plugin.Service)
      const forms = yield* Form.Service
      const location = yield* Location.Service
      const agents = yield* AgentService.Service
      yield* agents.transform((editor) =>
        editor.update("delegate-test" as never, (agent) => {
          agent.mode = "primary"
        }),
      )
      const session = yield* host.session.create({ title: "bind" })
      const binding = yield* host.delegate.tools.bind({
        sessionID: session.id,
        agent: "delegate-test",
        messageID: "msg_1",
      })
      expect(binding.definitions.map((item) => item.name)).toContain("question")
      const created = yield* formCreated
      // The binding runs the tool as a runtime does: on the default runtime, outside this fiber.
      const fiber = yield* Effect.promise(() =>
        binding.execute({
          name: "question",
          args: {
            questions: [
              { question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Go on" }] },
            ],
          },
          callID: "call_1",
          signal: new AbortController().signal,
        }),
      ).pipe(Effect.forkScoped)
      const event = yield* Deferred.await(created)
      expect(event.form.sessionID).toBe(session.id)
      expect(event.location).toEqual({ directory: location.directory, workspaceID: location.workspaceID })
      // The entry settles on the default runtime's next tick; the reply reads it from this one.
      yield* Effect.promise(() => Bun.sleep(1))
      yield* forms.reply({ id: event.form.id, answer: { q0: "Yes" } })
      const result = yield* Fiber.join(fiber)
      expect(result.content.some((part) => part.type === "text" && part.text.includes("Yes"))).toBe(true)
    }),
  )

  // Dismissal and interruption through the real binding, as both runtimes reach the host question.
  for (const settle of ["dismiss", "interrupt"] as const)
    it.effect(`settles a bound host question on ${settle}, attributed to the call, and refuses a late reply`, () =>
      Effect.gen(function* () {
        yield* registerToolPlugin(QuestionTool.Plugin)
        const host = yield* PluginHost.make(yield* Plugin.Service)
        const forms = yield* Form.Service
        const agents = yield* AgentService.Service
        yield* agents.transform((editor) =>
          editor.update("delegate-test" as never, (agent) => {
            agent.mode = "primary"
          }),
        )
        const session = yield* host.session.create({ title: "bind" })
        const binding = yield* host.delegate.tools.bind({
          sessionID: session.id,
          agent: "delegate-test",
          messageID: "msg_1",
        })
        const created = yield* formCreated
        const controller = new AbortController()
        const pending = binding
          .execute({
            name: "question",
            args: {
              questions: [
                { question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Go on" }] },
              ],
            },
            callID: "call_1",
            signal: controller.signal,
          })
          .then(
            () => "answered",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          )
        const event = yield* Deferred.await(created)
        expect(event.form.sessionID).toBe(session.id)
        expect(event.form.metadata).toEqual({ kind: "question", tool: { messageID: "msg_1", id: "call_1" } })
        yield* Effect.promise(() => Bun.sleep(1))
        if (settle === "dismiss") yield* forms.cancel(event.form.id)
        else controller.abort()
        const outcome = yield* Effect.promise(() => pending)
        if (settle === "dismiss") expect(outcome).toBe("The user dismissed this question")
        else expect(outcome).not.toBe("answered")
        expect(yield* forms.state(event.form.id)).toEqual({ status: "cancelled" })
        expect(yield* forms.list({ sessionID: session.id })).toEqual([])
        const late = yield* forms.reply({ id: event.form.id, answer: { q0: "Yes" } }).pipe(Effect.flip)
        expect(late._tag).toBe("Form.AlreadySettledError")
      }),
    )

  it.effect("binds tools only for a live session and agent", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* Plugin.Service)
      const missingSession = yield* Effect.flip(
        host.delegate.tools.bind({ sessionID: "ses_missing", agent: "build", messageID: "msg_1" }),
      )
      expect(missingSession.message).toContain("Session not found")
      const session = yield* host.session.create({ title: "bind" })
      const missingAgent = yield* Effect.flip(
        host.delegate.tools.bind({ sessionID: session.id, agent: "no-such-agent", messageID: "msg_1" }),
      )
      expect(missingAgent.message).toContain("Agent is no longer available")
    }),
  )

  it.effect("lists only described, auto-invokable skills that neither the agent nor the session denies", () =>
    Effect.gen(function* () {
      const agents = yield* AgentService.Service
      yield* agents.transform((editor) =>
        editor.update("delegate-test" as never, (agent) => {
          agent.permissions.push({ action: "skill", resource: "agent-denied", effect: "deny" })
        }),
      )
      const skills = yield* Skill.Service
      const skill = (id: string, extra: Partial<Skill.Info> = {}) =>
        ({ id, name: id, description: `${id} skill`, path: `/skills/${id}/SKILL.md`, content: "", ...extra }) as never
      yield* skills.transform((editor) => {
        editor.add(skill("offered"))
        editor.add(skill("undescribed", { description: undefined }))
        editor.add(skill("manual", { autoinvoke: false }))
        editor.add(skill("agent-denied"))
        editor.add(skill("session-denied"))
      })
      const host = yield* hostWith({
        inspect: (input) =>
          Effect.succeed({
            effect: input.resources.includes("session-denied") ? ("deny" as const) : ("allow" as const),
          }),
      })
      const listed = yield* host.delegate.context.skills({ sessionID: "ses_1", agent: "delegate-test" })
      expect(listed).toEqual([{ id: "offered", name: "offered", description: "offered skill" }])
      expect(yield* host.delegate.context.skills({ sessionID: "ses_1", agent: "no-such-agent" })).toEqual([])
    }),
  )

  it.effect("builds the base prompt a native agent would get, split static/dynamic", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* Plugin.Service)
      const agents = yield* AgentService.Service
      yield* agents.transform((editor) =>
        editor.update("delegate-test" as never, (agent) => {
          agent.mode = "primary"
        }),
      )
      const base = yield* host.delegate.context.system({
        sessionID: "ses_1",
        agent: "delegate-test",
        tools: ["read", "edit", "shell"],
      })
      expect(base.static).toHaveLength(1)
      expect(base.static[0]).toContain("You are an AI agent powered by redsun")
      expect(base.static[0]).toContain("Use the edit tool for targeted changes")
      expect(base.static[0]).toContain("Prefer dedicated tools over shell commands")
      expect(base.static[0]).toContain("# Code comments")
      expect(base.static[0]).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
      expect(base.dynamic.some((part) => part.includes("<env>") && part.includes("ses_1"))).toBe(true)
      expect(base.dynamic.some((part) => part.startsWith("Today's date:"))).toBe(true)
      // Guidance follows the served tools: no edit line without the edit tool.
      const readOnly = yield* host.delegate.context.system({
        sessionID: "ses_1",
        agent: "delegate-test",
        tools: ["read"],
      })
      expect(readOnly.static[0]).not.toContain("Use the edit tool for targeted changes")
      // A custom agent prompt replaces the base and the provider note, as native requests do.
      yield* agents.transform((editor) =>
        editor.update("delegate-test" as never, (agent) => {
          agent.system = "You are a custom agent."
        }),
      )
      const custom = yield* host.delegate.context.system({
        sessionID: "ses_1",
        agent: "delegate-test",
        tools: ["read"],
      })
      expect(custom.static).toEqual(["You are a custom agent."])
      expect(
        yield* host.delegate.context
          .system({ sessionID: "ses_1", agent: "no-such-agent", tools: [] })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Error)
    }),
  )

  it.effect("creates mirrored child sessions under their parent", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* Plugin.Service)
      const parent = yield* host.session.create({ title: "parent" })
      const childID = yield* host.delegate.transcript.createChild({
        parentID: parent.id,
        title: "explore the repo (@explore subagent)",
        agent: "explore",
        model: { providerID: OWNED, id: "model-1" },
      })
      const child = yield* host.session.get({ sessionID: childID as never })
      expect(child.parentID).toBe(parent.id)
      expect(child.title).toBe("explore the repo (@explore subagent)")
      expect(host.delegate.transcript.messageID()).not.toBe(host.delegate.transcript.messageID())
    }),
  )

  it.effect("inspects without prompting and forwards the typed check", () =>
    Effect.gen(function* () {
      const seen: unknown[] = []
      const host = yield* hostWith({
        inspect: (input) =>
          Effect.sync(() => {
            seen.push(input)
            return { effect: "deny" as const, message: "blocked" }
          }),
      })
      const result = yield* host.delegate.permission.inspect({
        sessionID: "ses_1",
        agent: "plan",
        action: "shell",
        resources: ["rm -rf /"],
      })
      expect(result).toEqual({ effect: "deny", message: "blocked" })
      expect(seen).toEqual([{ sessionID: "ses_1", agent: "plan", action: "shell", resources: ["rm -rf /"] }])
    }),
  )
})
