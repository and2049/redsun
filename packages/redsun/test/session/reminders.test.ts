import { describe, expect, test } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionReminders } from "@/session/reminders"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { it } from "../lib/effect"

const sessionID = SessionID.make("ses_reminders")
const messageID = MessageID.make("msg_reminders")

const CLAUDE_CODE = { providerID: "claude-code" }
const ANTHROPIC = { providerID: "anthropic" }

function messages(): SessionV1.WithParts[] {
  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "plan",
        model: { providerID: "claude-code", modelID: "sonnet" },
      } as never,
      parts: [
        {
          id: PartID.make("prt_reminders"),
          messageID,
          sessionID,
          type: "text",
          text: "do the thing",
        } as never,
      ],
    },
  ]
}

const session = { id: sessionID, slug: "slug", time: { created: 1 } } as unknown as Session.Info
const agent = (name: string) => ({ name, mode: "primary", permission: [], options: {} }) as never

function assistant(agentName: string, id: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "assistant",
      time: { created: 0 },
      agent: agentName,
    } as never,
    parts: [],
  }
}

const run = (input: {
  agent: string
  model: { providerID: string }
  experimentalPlanMode?: boolean
  msgs?: SessionV1.WithParts[]
  reminders?: { plan?: boolean; compose?: boolean; worker?: boolean; build_switch?: boolean }
}) =>
  SessionReminders.apply({
    messages: input.msgs ?? messages(),
    agent: agent(input.agent),
    session,
    model: input.model,
    reminders: input.reminders,
  }).pipe(
    Effect.provide(RuntimeFlags.layer({ experimentalPlanMode: input.experimentalPlanMode ?? true })),
    Effect.provideService(FSUtil.Service, {} as never),
    Effect.provideService(Session.Service, {
      updatePart: (part: unknown) => Effect.succeed(part),
    } as never),
  )

const synthetic = (result: SessionV1.WithParts[]) =>
  result[0]!.parts.filter((part) => part.type === "text" && part.synthetic)

describe("session reminders for delegated sessions", () => {
  it.effect("skips redsun's plan-mode reminder, which Claude Code's own plan mode replaces", () =>
    Effect.gen(function* () {
      const result = yield* run({ agent: "plan", model: CLAUDE_CODE })
      expect(synthetic(result)).toHaveLength(0)
    }),
  )

  it.effect("skips the legacy plan reminder too", () =>
    Effect.gen(function* () {
      const result = yield* run({ agent: "plan", model: CLAUDE_CODE, experimentalPlanMode: false })
      expect(synthetic(result)).toHaveLength(0)
    }),
  )

  it.effect("still injects the compose reminder, which is model-agnostic", () =>
    Effect.gen(function* () {
      const result = yield* run({ agent: "compose", model: CLAUDE_CODE })
      const parts = synthetic(result)
      expect(parts).toHaveLength(1)
      expect((parts[0] as { text: string }).text).toContain("compose agent")
    }),
  )

  it.effect("still injects the worker reminder", () =>
    Effect.gen(function* () {
      const result = yield* run({ agent: "worker", model: CLAUDE_CODE })
      expect(synthetic(result)).toHaveLength(1)
    }),
  )

  it.effect("does not inject compose/worker/plan message parts for non-delegated models", () =>
    Effect.gen(function* () {
      // Standing briefs moved to the stable system prefix (systemBrief) for
      // non-delegated sessions so they no longer break the provider cache.
      for (const agent of ["plan", "compose", "worker"]) {
        const result = yield* run({ agent, model: ANTHROPIC, experimentalPlanMode: false })
        expect(synthetic(result)).toHaveLength(0)
      }
    }),
  )
})

describe("systemBrief", () => {
  test("returns the standing brief per agent for non-delegated sessions", () => {
    expect(SessionReminders.systemBrief({ agentName: "compose", delegated: false, experimentalPlanMode: false })).toContain(
      "compose agent",
    )
    expect(SessionReminders.systemBrief({ agentName: "worker", delegated: false, experimentalPlanMode: false })).toBeDefined()
    expect(SessionReminders.systemBrief({ agentName: "plan", delegated: false, experimentalPlanMode: false })).toContain(
      "Plan Mode",
    )
    expect(SessionReminders.systemBrief({ agentName: "build", delegated: false, experimentalPlanMode: false })).toBeUndefined()
  })

  test("returns nothing for delegated sessions", () => {
    for (const agentName of ["plan", "compose", "worker"]) {
      expect(SessionReminders.systemBrief({ agentName, delegated: true, experimentalPlanMode: false })).toBeUndefined()
    }
  })

  test("plan brief is owned by the experimental machinery when the flag is on", () => {
    expect(SessionReminders.systemBrief({ agentName: "plan", delegated: false, experimentalPlanMode: true })).toBeUndefined()
    expect(SessionReminders.systemBrief({ agentName: "compose", delegated: false, experimentalPlanMode: true })).toBeDefined()
  })

  test("toggles suppress each brief", () => {
    expect(
      SessionReminders.systemBrief({
        agentName: "compose",
        delegated: false,
        experimentalPlanMode: false,
        reminders: { compose: false },
      }),
    ).toBeUndefined()
    expect(
      SessionReminders.systemBrief({
        agentName: "worker",
        delegated: false,
        experimentalPlanMode: false,
        reminders: { worker: false },
      }),
    ).toBeUndefined()
    expect(
      SessionReminders.systemBrief({
        agentName: "plan",
        delegated: false,
        experimentalPlanMode: false,
        reminders: { plan: false },
      }),
    ).toBeUndefined()
  })
})

describe("build-switch reminder", () => {
  it.effect("fires when the most recent assistant turn was from the plan agent", () =>
    Effect.gen(function* () {
      const msgs = [assistant("plan", "msg_a1"), ...messages()]
      const result = yield* run({ agent: "build", model: ANTHROPIC, experimentalPlanMode: false, msgs })
      const parts = synthetic(result.filter((m) => m.info.role === "user"))
      expect(parts).toHaveLength(1)
    }),
  )

  it.effect("does not fire again after a build turn follows the plan turn", () =>
    Effect.gen(function* () {
      const msgs = [assistant("plan", "msg_a1"), assistant("build", "msg_a2"), ...messages()]
      const result = yield* run({ agent: "build", model: ANTHROPIC, experimentalPlanMode: false, msgs })
      const parts = synthetic(result.filter((m) => m.info.role === "user"))
      expect(parts).toHaveLength(0)
    }),
  )
})

describe("reminder toggles", () => {
  it.effect("build_switch: false suppresses the switch notice", () =>
    Effect.gen(function* () {
      const msgs = [assistant("plan", "msg_a1"), ...messages()]
      const result = yield* run({
        agent: "build",
        model: ANTHROPIC,
        experimentalPlanMode: false,
        msgs,
        reminders: { build_switch: false },
      })
      expect(synthetic(result.filter((m) => m.info.role === "user"))).toHaveLength(0)
    }),
  )

  it.effect("compose: false suppresses the delegated compose brief part", () =>
    Effect.gen(function* () {
      const result = yield* run({ agent: "compose", model: CLAUDE_CODE, reminders: { compose: false } })
      expect(synthetic(result)).toHaveLength(0)
    }),
  )

  it.effect("worker: false suppresses the delegated worker brief part", () =>
    Effect.gen(function* () {
      const result = yield* run({ agent: "worker", model: CLAUDE_CODE, reminders: { worker: false } })
      expect(synthetic(result)).toHaveLength(0)
    }),
  )
})
