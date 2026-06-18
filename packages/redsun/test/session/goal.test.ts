import { describe, expect, test } from "bun:test"
import path from "path"
import { Bus } from "../../src/bus"
import { Event as GoalEvent, Goal } from "../../src/session/goal"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")
const sessionID = (name: string) => `ses_goal_${name}_${Math.random().toString(36).slice(2)}`
const testModel = { id: "test-model", providerID: "test-provider" } as any
const testAgent = { name: "build" } as any

async function seedConversation(sessionID: string) {
  const userID = Identifier.ascending("message")
  const assistantID = Identifier.ascending("message")
  await Session.updateMessage({
    id: userID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test-provider", modelID: "test-model" },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: userID,
    sessionID,
    type: "text",
    text: "Please finish the work.",
  })
  await Session.updateMessage({
    id: assistantID,
    sessionID,
    parentID: userID,
    role: "assistant",
    mode: "build",
    agent: "build",
    path: {
      cwd: Instance.directory,
      root: Instance.worktree,
    },
    cost: 0,
    tokens: {
      input: 1,
      output: 1,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: "test-model",
    providerID: "test-provider",
    time: { created: Date.now() + 1 },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistantID,
    sessionID,
    type: "text",
    text: "The work is finished.",
  })
  return { userID, assistantID }
}

describe("Goal persistence", () => {
  test("set/get/bump/clear uses persisted storage", async () => {
    await using tmp = await tmpdir({ git: true })
    const sid = sessionID("persist")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Goal.set(sid, "finish the review")
        expect(await Goal.get(sid)).toEqual({ condition: "finish the review", react: 0 })

        expect(await Goal.bumpReact(sid)).toBe(1)
        expect(await Goal.get(sid)).toEqual({ condition: "finish the review", react: 1 })

        await Goal.clear(sid)
        expect(await Goal.get(sid)).toBeUndefined()
      },
    })
  })

  test("goal survives instance disposal for the same stored session id", async () => {
    await using tmp = await tmpdir({ git: true })
    const sid = sessionID("dispose")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Goal.set(sid, "survive dispose")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Instance.dispose()
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await Goal.get(sid)).toEqual({ condition: "survive dispose", react: 0 })
        await Goal.clear(sid)
      },
    })
  })
})

describe("/goal command", () => {
  test("sets and clears goals and publishes update events", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const events: Array<string | undefined> = []
        const unsub = Bus.subscribe(GoalEvent.Updated, (event) => {
          events.push(event.properties.goal?.condition)
        })

        await SessionPrompt.command({
          sessionID: session.id,
          agent: "build",
          command: "goal",
          arguments: "produce a final report",
        })
        expect(await Goal.get(session.id)).toEqual({ condition: "produce a final report", react: 0 })

        await SessionPrompt.command({
          sessionID: session.id,
          agent: "build",
          command: "goal",
          arguments: "",
        })
        expect(await Goal.get(session.id)).toBeUndefined()

        unsub()
        await Session.remove(session.id)

        expect(events).toContain("produce a final report")
        expect(events).toContain(undefined)
      },
    })
  })
})

describe("Goal stop gate", () => {
  test("satisfied verdict clears goal and allows stop", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await seedConversation(session.id)
        await Goal.set(session.id, "finish")

        const result = await SessionPrompt.handleGoalStop({
          sessionID: session.id,
          agent: testAgent,
          model: testModel,
          evaluate: async () => ({ ok: true, reason: "done" }),
        })

        expect(result).toEqual({ action: "stop" })
        expect(await Goal.get(session.id)).toBeUndefined()
        await Session.remove(session.id)
      },
    })
  })

  test("impossible verdict clears goal and allows stop", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await seedConversation(session.id)
        await Goal.set(session.id, "finish")

        const result = await SessionPrompt.handleGoalStop({
          sessionID: session.id,
          agent: testAgent,
          model: testModel,
          evaluate: async () => ({ ok: false, impossible: true, reason: "blocked" }),
        })

        expect(result).toEqual({ action: "stop" })
        expect(await Goal.get(session.id)).toBeUndefined()
        await Session.remove(session.id)
      },
    })
  })

  test("unsatisfied verdict increments react and writes synthetic continuation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await seedConversation(session.id)
        await Goal.set(session.id, "finish")

        const result = await SessionPrompt.handleGoalStop({
          sessionID: session.id,
          agent: testAgent,
          model: testModel,
          evaluate: async () => ({ ok: false, reason: "not yet" }),
        })

        expect(result).toEqual({ action: "continue" })
        expect(await Goal.get(session.id)).toEqual({ condition: "finish", react: 1 })
        const messages = await Session.messages({ sessionID: session.id })
        const synthetic = messages.find((msg) =>
          msg.info.role === "user" && msg.parts.some((part) => part.type === "text" && part.synthetic),
        )
        expect(synthetic?.parts.some((part) => part.type === "text" && part.text.includes("not yet"))).toBe(true)
        await Goal.clear(session.id)
        await Session.remove(session.id)
      },
    })
  })

  test("react cap clears goal and allows stop", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await seedConversation(session.id)
        await Goal.set(session.id, "finish")
        for (let i = 0; i < 12; i++) {
          await Goal.bumpReact(session.id)
        }

        const result = await SessionPrompt.handleGoalStop({
          sessionID: session.id,
          agent: testAgent,
          model: testModel,
          evaluate: async () => ({ ok: false, reason: "still not done" }),
        })

        expect(result).toEqual({ action: "stop" })
        expect(await Goal.get(session.id)).toBeUndefined()
        await Session.remove(session.id)
      },
    })
  })

  test("judge error allows stop and leaves goal stored", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await seedConversation(session.id)
        await Goal.set(session.id, "finish")

        const result = await SessionPrompt.handleGoalStop({
          sessionID: session.id,
          agent: testAgent,
          model: testModel,
          evaluate: async () => {
            throw new Error("judge unavailable")
          },
        })

        expect(result).toEqual({ action: "stop" })
        expect(await Goal.get(session.id)).toEqual({ condition: "finish", react: 0 })
        await Goal.clear(session.id)
        await Session.remove(session.id)
      },
    })
  })

  test("judge receives latest persisted messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const ids = await seedConversation(session.id)
        await Goal.set(session.id, "finish")
        let seenAssistant = false

        await SessionPrompt.handleGoalStop({
          sessionID: session.id,
          agent: testAgent,
          model: testModel,
          evaluate: async (input) => {
            seenAssistant = input.msgs.some((msg) => msg.info.id === ids.assistantID)
            return { ok: true, reason: "done" }
          },
        })

        expect(seenAssistant).toBe(true)
        await Session.remove(session.id)
      },
    })
  })
})
