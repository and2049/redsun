import { expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Event as GoalEvent, Goal } from "../../src/session/goal"
import { SessionPrompt } from "../../src/session/prompt"
import { Identifier } from "../../src/id/id"
import { Bus } from "../../src/bus"
import { tmpdir } from "../fixture/fixture"

async function seedCompletedTurn(sessionID: string, providerID = "goal-test", modelID = "judge") {
  const userID = Identifier.ascending("message")
  const assistantID = Identifier.ascending("message")
  await Session.updateMessage({
    id: userID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID, modelID },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: userID,
    sessionID,
    type: "text",
    text: "Finish the task.",
  })
  await Session.updateMessage({
    id: assistantID,
    sessionID,
    parentID: userID,
    role: "assistant",
    mode: "build",
    agent: "build",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID,
    providerID,
    finish: "stop",
    time: { created: Date.now() + 1, completed: Date.now() + 2 },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistantID,
    sessionID,
    type: "text",
    text: "The task is complete.",
  })
}

function fakeProvider(verdict: { ok: boolean; reason: string }) {
  let requests = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests++
      const body = await request.json().catch(() => ({})) as Record<string, unknown>
      if (body.stream === true) {
        return new Response("", { status: 499 })
      }
      return Response.json({
        id: "chatcmpl-goal-test",
        object: "chat.completion",
        created: 0,
        model: "judge",
        choices: [{
          index: 0,
          message: { role: "assistant", content: JSON.stringify(verdict) },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  return { server, get requests() { return requests } }
}

async function writeProviderConfig(dir: string, api: string) {
  await Bun.write(path.join(dir, "redsun.json"), JSON.stringify({
    provider: {
      "goal-test": {
        name: "Goal Test",
        npm: "@ai-sdk/openai-compatible",
        api,
        options: { apiKey: "test" },
        models: {
          judge: {
            name: "Judge",
            tool_call: true,
            limit: { context: 128000, output: 4096 },
          },
        },
      },
    },
  }))
}

test("normal completion with a satisfied goal is judged before loop exit", async () => {
  const fake = fakeProvider({ ok: true, reason: "The transcript says the task is complete." })
  using _server = fake.server
  await using tmp = await tmpdir({ init: (dir) => writeProviderConfig(dir, `${fake.server.url}v1`) })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await seedCompletedTurn(session.id)
      await Goal.set(session.id, "finish the task")

      await SessionPrompt.loop(session.id)

      expect(fake.requests).toBe(1)
      expect(await Goal.get(session.id)).toBeUndefined()
      await Session.remove(session.id)
    },
  })
})

test("normal completion with an unsatisfied goal writes a continuation", async () => {
  const fake = fakeProvider({ ok: false, reason: "The final verification is missing." })
  using _server = fake.server
  await using tmp = await tmpdir({ init: (dir) => writeProviderConfig(dir, `${fake.server.url}v1`) })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await seedCompletedTurn(session.id)
      await Goal.set(session.id, "finish the task")

      const unsubscribe = Bus.subscribe(GoalEvent.Updated, (event) => {
        if (event.properties.sessionID === session.id && event.properties.lastVerdict?.ok === false) {
          SessionPrompt.cancel(session.id)
        }
      })
      await SessionPrompt.loop(session.id)
      unsubscribe()

      expect(await Goal.get(session.id)).toEqual({ condition: "finish the task", react: 1 })
      const messages = await Session.messages({ sessionID: session.id })
      expect(messages.some((message) =>
        message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.synthetic),
      )).toBe(true)
      await Goal.clear(session.id)
      await Session.remove(session.id)
    },
  })
})

test("normal completion without a goal exits without resolving a provider", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await seedCompletedTurn(session.id, "missing-provider", "missing-model")

      await SessionPrompt.loop(session.id)

      expect(await Goal.get(session.id)).toBeUndefined()
      await Session.remove(session.id)
    },
  })
})
