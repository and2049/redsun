import { describe, expect } from "bun:test"
import path from "node:path"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import AcpPlugin from "../../runtime-acp/src/index"
import { AISDK } from "@opencode/core/aisdk"
import { DelegatedRuntime } from "@opencode/core/delegate"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

// REDSUN: the second delegated runtime. The ACP runtime is an ordinary plugin package that
// imports nothing from core; loaded through the real plugin host with a scripted ACP agent, it
// registers a provider and a runtime, and a request flows through core's request tagging and
// AI SDK bridge into the agent and back.

const it = testEffect(PluginTestLayer)

const fixture = path.join(import.meta.dir, "../../runtime-acp/test/fixture/agent.ts")

const session = Session.Info.make({
  id: Session.ID.make("ses_acp"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})

const sleep = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

/** Connects the agent's integration as the user would; its sign-in check starts an ACP session. */
const connect = (integrationID: string) =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const id = Integration.ID.make(integrationID)
    const attempt = yield* integrations.oauth.connect({
      integrationID: id,
      methodID: Integration.MethodID.make("acp-cli-login"),
    })
    for (let waited = 0; waited < 10_000; waited += 50) {
      const status = yield* integrations.oauth.status({ integrationID: id, attemptID: attempt.attemptID })
      if (status.status !== "pending") return status
      yield* sleep(50)
    }
    throw new Error("the connection did not settle")
  })

const collect = async (stream: ReadableStream<LanguageModelV3StreamPart>) => {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

describe("ACP runtime plugin through the real host", () => {
  it.effect("lists the models the agent reports once it has discovered them", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* Plugin.Service)
      yield* AcpPlugin.effect({
        ...host,
        options: {
          agents: {
            fake: { command: process.execPath, args: [fixture], env: { FAKE_ACP_MODELS: "legacy" } },
          },
        },
      })
      yield* connect("fake")
      const models = yield* Model.Service
      let fast = yield* models.get("fake" as never, "fast" as never)
      for (let waited = 0; !fast && waited < 10_000; waited += 50) {
        yield* sleep(50)
        fast = yield* models.get("fake" as never, "fast" as never)
      }
      expect(fast?.name).toBe("Fast")
      expect((yield* models.get("fake" as never, "default" as never))?.name).toBe("fake")
    }),
  )

  it.effect("registers its agent as a delegated provider and answers a tagged request", () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* Plugin.Service)
      yield* AcpPlugin.effect({
        ...host,
        options: {
          agents: {
            fake: { name: "Fake-acp", command: process.execPath, args: [fixture], nativeApprovalMode: "trust" },
          },
        },
      })

      const delegates = yield* DelegatedRuntime.Service
      expect(yield* delegates.owns({ providerID: "fake" })).toBe(true)
      expect(yield* delegates.nativeApproval({ providerID: "fake", id: "default" })).toBe(true)

      // The agent is an integration to connect, like Claude Code; its models follow the connection.
      const integration = yield* (yield* Integration.Service).get(Integration.ID.make("fake"))
      expect(integration?.name).toBe("Fake-acp")
      const models = yield* Model.Service
      expect(yield* models.get("fake" as never, "default" as never)).toBeUndefined()
      expect((yield* connect("fake")).status).toBe("complete")
      const info = yield* models.get("fake" as never, "default" as never)
      expect(info?.name).toBe("Fake-acp")

      const transport = SessionModelTransport.Service.of({
        bind: () => ({ execute: () => Effect.die("unused") }),
        close: () => Effect.void,
        closeAll: Effect.void,
      })
      const prepared = yield* Effect.gen(function* () {
        const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
        return yield* requests.primary({
          session,
          agent: Agent.ID.make("build"),
          model: SessionRunnerModel.resolved(
            LanguageModel.make({ id: "default", provider: "fake", route: OpenAIChat.route }),
            {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              cost: [],
              limit: { context: 1, output: 1 },
            },
          ),
          system: [],
          messages: [],
        })
      }).pipe(Effect.provideService(SessionModelTransport.Service, transport))

      const language = yield* (yield* AISDK.Service).language(info!)
      const parts = yield* Effect.promise(async () =>
        collect(
          (
            await language.doStream({
              prompt: [{ role: "user", content: [{ type: "text", text: "echo from the host" }] }],
              headers: prepared.request.http?.headers,
            })
          ).stream,
        ),
      )
      const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
      // The host context goes ahead of the first prompt.
      expect(text).toStartWith("SESSION=acp_1 TURNS=1 PROMPT=<redsun-context>")
      expect(text).toEndWith("</redsun-context>\n\necho from the host")
      expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } })
    }),
  )
})
