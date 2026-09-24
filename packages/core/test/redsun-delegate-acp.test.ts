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

      const models = yield* Model.Service
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
      expect(text).toBe("SESSION=acp_1 TURNS=1 PROMPT=echo from the host")
      expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "stop" } })
    }),
  )
})
