export * as SessionGenerateNode from "./generate-node.js"

import { LLMClient, Message, SystemPart } from "@opencode-ai/ai"
import { Effect, Layer } from "effect"
import { Database } from "../database/database.js"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { llmClient } from "../effect/app-node-platform.js"
import { SessionContext } from "./context.js"
import { SessionGenerate } from "./generate.js"
import { SessionHistory } from "./history.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionRunnerModel } from "./runner/model.js"

export const layer = Layer.effect(
  SessionGenerate.Service,
  Effect.gen(function* () {
    const context = yield* SessionContext.Service
    const database = yield* Database.Service
    const llm = yield* LLMClient.Service
    const models = yield* SessionRunnerModel.Service
    const modelRequests = yield* SessionModelRequest.Service

    return SessionGenerate.Service.of({
      generate: Effect.fn("SessionGenerate.generate")(function* (input) {
        const selection = yield* context.select(input.sessionID)
        // REDSUN: judge/advisor controls — optional model override, replacement system
        // prompt, tool suppression, and temperature for transient evaluation calls.
        const model = yield* models.resolve(
          input.model ? { ...selection.session, model: input.model } : selection.session,
        )
        const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions)
        // REDSUN: tool suppression empties the toolset and forces toolChoice "none"; a
        // replacement system prompt substitutes wholesale.
        const tools = input.tools === false ? { ...selection.tools, definitions: [] } : selection.tools
        const transcript = SessionModelRequest.baseTranscript({
          agent: selection.agent.info,
          model,
          tools,
          initial: history.initial,
          messages: history.messages,
        })
        const prepared = yield* modelRequests.prepare({
          scope: { session: selection.session, agentID: selection.agent.id, model, tools },
          transcript: {
            system: input.system !== undefined ? [SystemPart.make(input.system)] : transcript.system,
            messages: [
              ...transcript.messages,
              ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []),
              Message.user(input.prompt),
            ],
          },
          ...(input.tools === false ? { toolChoice: "none" as const } : {}),
        })
        yield* Effect.logInfo("sending session generation request", {
          sessionID: selection.session.id,
          providerID: model.ref.providerID,
          modelID: model.ref.id,
        })
        const request =
          input.temperature !== undefined
            ? { ...prepared.request, generation: { ...prepared.request.generation, temperature: input.temperature } }
            : prepared.request
        const response = yield* llm.generate(request, prepared.options)
        yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
        return response.text
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: SessionGenerate.Service,
  layer,
  deps: [SessionContext.node, Database.node, SessionModelRequest.node, SessionRunnerModel.node, llmClient],
})
