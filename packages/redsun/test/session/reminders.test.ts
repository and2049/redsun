import { describe, expect } from "bun:test"
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

const run = (input: {
  agent: string
  model: { providerID: string }
  experimentalPlanMode?: boolean
  msgs?: SessionV1.WithParts[]
}) =>
  SessionReminders.apply({
    messages: input.msgs ?? messages(),
    agent: agent(input.agent),
    session,
    model: input.model,
  }).pipe(
    Effect.provide(RuntimeFlags.layer({ experimentalPlanMode: input.experimentalPlanMode ?? true })),
    Effect.provideService(FSUtil.Service, {} as never),
    Effect.provideService(Session.Service, {} as never),
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

  it.effect("keeps the legacy plan reminder for non-delegated models", () =>
    Effect.gen(function* () {
      const result = yield* run({ agent: "plan", model: ANTHROPIC, experimentalPlanMode: false })
      expect(synthetic(result)).toHaveLength(1)
    }),
  )
})
