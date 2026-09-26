import { describe, expect } from "bun:test"
import path from "node:path"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import AcpPlugin from "../../runtime-acp/src/index"
import { Agent as AgentService } from "@opencode/core/agent"
import { AISDK } from "@opencode/core/aisdk"
import { Bus } from "@opencode/core/bus"
import { DelegatedRuntime } from "@opencode/core/delegate"
import { Form } from "@opencode/core/form"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { QuestionTool } from "@opencode/core/tool/plugin/question"
import { RedsunWorkerModelTool } from "@opencode/core/plugin/redsun/worker-model-tool"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { registerToolPlugin } from "./lib/tool"
import { PluginPermissionTestLayer } from "./plugin/fixture"

// REDSUN: generic ACP qualification against the real host boundary. The scripted agent calls host
// tools over the runtime's actual MCP endpoint; the tools run through core's delegate binding,
// the real permission service and the real form service, so nothing on the host side is stubbed.

const it = testEffect(PluginPermissionTestLayer)

const fixture = path.join(import.meta.dir, "../../runtime-acp/test/fixture/agent.ts")
const AGENT = "delegate-test"

/** A host tool that asks the host permission policy, as native leaves do. */
const ProbeTool = {
  id: "test.probe",
  effect: Effect.fn(function* (ctx: Parameters<typeof QuestionTool.Plugin.effect>[0]) {
    const permission = yield* Permission.Service
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name: "probe",
          options: { codemode: false },
          description: "Asks the host before it runs.",
          input: Schema.Struct({ target: Schema.String }),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: (input, context) =>
            permission
              .assert({
                action: "probe",
                resources: [input.target],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                // As the tool runtime does at its boundary for a leaf that does not map its errors.
                Effect.mapError((error) => new Tool.Error({ message: error.message })),
                Effect.as({ output: { ok: true }, content: [{ type: "text" as const, text: "PROBED" }] }),
              ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

const QUESTION = {
  questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Go on" }] }],
}

/** The final request catalog core would send; the runtime intersects the binding with it. */
const TOOLS: LanguageModelV3CallOptions["tools"] = ["question", "probe", "worker_model"].map((name) => ({
  type: "function" as const,
  name,
  inputSchema: { type: "object" as const },
}))

const sleep = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

const collect = async (stream: ReadableStream<LanguageModelV3StreamPart>) => {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

/** The one event of a type published next, from the moment this is called. */
const next = <A>(type: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const seen = yield* Deferred.make<A>()
    const unsubscribe = yield* bus.listen((event) =>
      event.type === type ? Deferred.succeed(seen, event.data as A).pipe(Effect.asVoid) : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return seen
  })

const setup = (v3: boolean) =>
  Effect.gen(function* () {
    yield* registerToolPlugin(QuestionTool.Plugin)
    yield* registerToolPlugin(ProbeTool)
    yield* registerToolPlugin(RedsunWorkerModelTool.Plugin)
    const host = yield* PluginHost.make(yield* Plugin.Service)
    yield* AcpPlugin.effect({
      ...host,
      options: {
        agents: {
          fake: {
            command: process.execPath,
            args: [fixture],
            hostTools: "all",
            ...(v3
              ? {
                  preset: "kiro",
                  prompt: "none",
                  env: { FAKE_ACP_V3: "1" },
                  integration: { whoami: [fixture, "whoami"] },
                  home: { path: path.join(host.location.directory, ".fake-kiro-home") },
                }
              : {}),
          },
        },
      },
    })
    yield* (yield* AgentService.Service).transform((editor) =>
      editor.update(AGENT as never, (agent) => {
        agent.mode = "primary"
        // Probes ask, except the one an explicit rule denies.
        agent.permissions = [
          ...agent.permissions,
          { action: "probe", resource: "*", effect: "ask" },
          { action: "probe", resource: "secret", effect: "deny" },
        ]
      }),
    )
    const integrations = yield* Integration.Service
    const attempt = yield* integrations.oauth.connect({
      integrationID: Integration.ID.make("fake"),
      methodID: Integration.MethodID.make("acp-cli-login"),
    })
    for (let waited = 0; waited < 10_000; waited += 50) {
      const status = yield* integrations.oauth.status({
        integrationID: Integration.ID.make("fake"),
        attemptID: attempt.attemptID,
      })
      if (status.status !== "pending") break
      yield* sleep(50)
    }
    const info = yield* (yield* Model.Service).get("fake" as never, "default" as never)
    const language = yield* (yield* AISDK.Service).language(info!)
    const session = yield* host.session.create({ title: "acp host boundary" })
    let turns = 0
    /** One primary turn, tagged as core tags it, whose prompt makes the agent call a host tool. */
    const invoke = (name: string, args: unknown, signal?: AbortSignal) => {
      const messageID = `msg_${++turns}`
      return {
        messageID,
        parts: Effect.promise(async () =>
          collect(
            (
              await language.doStream({
                prompt: [
                  { role: "user", content: [{ type: "text", text: `invoke:${JSON.stringify({ name, args })}` }] },
                ],
                tools: TOOLS,
                ...(signal ? { abortSignal: signal } : {}),
                headers: {
                  [DelegatedRuntime.Headers.session]: session.id,
                  [DelegatedRuntime.Headers.agent]: AGENT,
                  [DelegatedRuntime.Headers.kind]: "primary",
                  [DelegatedRuntime.Headers.message]: messageID,
                },
              })
            ).stream,
          ),
        ),
      }
    }
    return { session, invoke, permission: yield* Permission.Service }
  })

/** What the agent received back from its host call, as it reported it. */
const reported = (parts: readonly LanguageModelV3StreamPart[]) => {
  const results = parts.filter((part) => part.type === "tool-result")
  expect(results).toHaveLength(1)
  const result = results[0] as Extract<LanguageModelV3StreamPart, { type: "tool-result" }>
  return JSON.stringify(result.result)
}

for (const v3 of [false, true])
  describe(`${v3 ? "Kiro v3" : "generic ACP"} host tools through the real host boundary`, () => {
    for (const dismiss of [false, true])
      it.live(`settles the shared worker picker over ACP (${dismiss ? "dismiss" : "choose"})`, () =>
        Effect.gen(function* () {
          const { session, invoke } = yield* setup(v3)
          const forms = yield* Form.Service
          const created = yield* next<{ readonly form: Form.Info }>(Form.Event.Created.type)
          const fiber = yield* Effect.forkScoped(invoke("worker_model", {}).parts)
          const { form } = yield* Deferred.await(created)
          expect(form.sessionID).toBe(session.id)
          expect(form.metadata).toMatchObject({ kind: "worker-model" })
          if (dismiss) yield* forms.cancel(form.id)
          else yield* forms.reply({ id: form.id, answer: { model: "fake/default" } })
          expect(reported(yield* Fiber.join(fiber))).toContain(
            dismiss ? "dismissed the worker model picker" : "fake/default",
          )
        }),
      )

    it.live("opens one question form attributed to the agent's call and returns the answer", () =>
      Effect.gen(function* () {
        const { session, invoke } = yield* setup(v3)
        const forms = yield* Form.Service
        const created = yield* next<{ readonly form: Form.Info }>(Form.Event.Created.type)
        const turn = invoke("question", QUESTION)
        const fiber = yield* Effect.forkScoped(turn.parts)
        const { form } = yield* Deferred.await(created)
        expect(form.sessionID).toBe(session.id)
        expect(form.metadata).toEqual({ kind: "question", tool: { messageID: turn.messageID, id: "call_invoke" } })
        expect(yield* forms.list({ sessionID: session.id })).toHaveLength(1)
        yield* forms.reply({ id: form.id, answer: { q0: "Yes" } })
        const parts = yield* Fiber.join(fiber)
        expect(parts.filter((part) => part.type === "tool-call").map((part) => part.toolCallId)).toEqual([
          "call_invoke",
        ])
        expect(reported(parts)).toContain("Yes")
        expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } })
      }),
    )

    it.live("continues the turn with the refusal when the user dismisses the question", () =>
      Effect.gen(function* () {
        const { invoke } = yield* setup(v3)
        const forms = yield* Form.Service
        const created = yield* next<{ readonly form: Form.Info }>(Form.Event.Created.type)
        const fiber = yield* Effect.forkScoped(invoke("question", QUESTION).parts)
        const { form } = yield* Deferred.await(created)
        yield* forms.cancel(form.id)
        const parts = yield* Fiber.join(fiber)
        expect(reported(parts)).toContain("The user dismissed this question")
        expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } })
      }),
    )

    for (const reply of ["once", "reject", "correct"] as const)
      it.live(`asks the host policy once for a host tool and relays the ${reply} reply`, () =>
        Effect.gen(function* () {
          const { session, invoke, permission } = yield* setup(v3)
          const asked = yield* next<Permission.Request>(Permission.Event.Asked.type)
          const turn = invoke("probe", { target: "src" })
          const fiber = yield* Effect.forkScoped(turn.parts)
          const request = yield* Deferred.await(asked)
          expect(request).toMatchObject({
            sessionID: session.id,
            action: "probe",
            resources: ["src"],
            source: { type: "tool", messageID: turn.messageID, id: "call_invoke" },
          })
          expect(yield* permission.forSession(session.id)).toHaveLength(1)
          yield* permission.reply(
            reply === "correct"
              ? { requestID: request.id, reply: "reject", message: "use the lib directory" }
              : { requestID: request.id, reply },
          )
          const parts = yield* Fiber.join(fiber)
          expect(reported(parts)).toContain(
            { once: "PROBED", reject: "The user declined this tool call", correct: "feedback: use the lib directory" }[
              reply
            ],
          )
          expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } })
        }),
      )

    it.live("releases a pending host ask when Auto-approve is selected, and still refuses a denied call", () =>
      Effect.gen(function* () {
        const { session, invoke, permission } = yield* setup(v3)
        const asked = yield* next<Permission.Request>(Permission.Event.Asked.type)
        const fiber = yield* Effect.forkScoped(invoke("probe", { target: "src" }).parts)
        yield* Deferred.await(asked)
        yield* permission.setMode("auto")
        expect(reported(yield* Fiber.join(fiber))).toContain("PROBED")
        const denied = yield* invoke("probe", { target: "secret" }).parts
        expect(reported(denied)).toContain("Permission denied: probe")
        expect(yield* permission.forSession(session.id)).toEqual([])
      }),
    )

    it.live("withdraws a pending host ask when the turn is cancelled, and the next turn recovers", () =>
      Effect.gen(function* () {
        const { session, invoke, permission } = yield* setup(v3)
        const asked = yield* next<Permission.Request>(Permission.Event.Asked.type)
        const controller = new AbortController()
        const withdrawn = yield* next<{ sessionID: string; requestID: string; reply: string }>(
          Permission.Event.Replied.type,
        )
        const fiber = yield* Effect.forkScoped(invoke("probe", { target: "src" }, controller.signal).parts)
        const cancelled = yield* Deferred.await(asked)
        controller.abort()
        yield* Fiber.join(fiber)
        for (let waited = 0; waited < 2_000 && (yield* permission.forSession(session.id)).length; waited += 20)
          yield* sleep(20)
        expect(yield* permission.forSession(session.id)).toEqual([])
        expect(yield* Deferred.await(withdrawn)).toEqual({
          sessionID: session.id,
          requestID: cancelled.id,
          reply: "reject",
        })
        const again = yield* next<Permission.Request>(Permission.Event.Asked.type)
        const retry = yield* Effect.forkScoped(invoke("probe", { target: "src" }).parts)
        const request = yield* Deferred.await(again)
        yield* permission.reply({ requestID: request.id, reply: "once" })
        expect(reported(yield* Fiber.join(retry))).toContain("PROBED")
      }),
    )
  })
