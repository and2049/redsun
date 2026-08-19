import { describe, expect } from "bun:test"
import { Message } from "@opencode-ai/ai"
import { DateTime, Effect, Stream } from "effect"
import type { SessionContext } from "@opencode-ai/plugin/effect/session"
import { Agent } from "@opencode-ai/core/agent"
import { Event } from "@opencode-ai/schema/event"
import { Location } from "@opencode-ai/core/location"
import { Model } from "@opencode-ai/core/model"
import { PlanPlugin } from "@opencode-ai/core/plugin/plan"
import { Provider } from "@opencode-ai/core/provider"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInbox } from "@opencode-ai/core/session/inbox"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { it } from "../lib/effect"
import { location } from "../fixture/location"
import { host } from "./host"

const sessionID = Session.ID.make("ses_plan_test")
const plan = Agent.ID.make("plan")
const build = Agent.ID.make("build")

const agentSelected = (agent: Agent.ID, previous: Agent.ID): SessionEvent.AgentSelected => ({
  id: Event.ID.create(),
  created: 0,
  durable: { aggregateID: sessionID, seq: Event.Seq.make(0), version: Event.Version.make(1) },
  type: "session.agent.selected",
  data: { sessionID, agent, previous },
})

const WORKTREE = AbsolutePath.make(process.platform === "win32" ? "C:\repo" : "/repo")

type ToolHook = (input: {
  tool: string
  agent: Agent.ID
  input: unknown
}) => Effect.Effect<void, { readonly message: string }>

/** Runs the plan plugin against stubbed domains, capturing persisted reminders and both hooks. */
const run = Effect.fnUntraced(function* (
  events: ReadonlyArray<SessionEvent.AgentSelected> = [],
  repo = true,
) {
  const persisted = new Array<string>()
  const rules = new Array<{ action: string; resource: string; effect: string }>()
  let contextHook: ((input: SessionContext) => Effect.Effect<void>) | undefined
  let toolHook: ToolHook | undefined
  yield* PlanPlugin.Plugin.effect(
    host({
      agent: {
        get: () => Effect.die("unused agent.get"),
        list: () => Effect.die("unused agent.list"),
        reload: () => Effect.die("unused agent.reload"),
        transform: (callback) => {
          callback({ update: (_id: string, update: (item: unknown) => void) => update({ permissions: rules }) } as never)
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      tool: {
        transform: () => Effect.die("unused tool.transform"),
        hook: (name, callback) => {
          if (name === "execute.before") toolHook = callback as unknown as ToolHook
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      event: {
        subscribe: () => Stream.fromIterable(events),
      },
      session: {
        hook: (name, callback) => {
          if (name === "context") contextHook = callback as (input: SessionContext) => Effect.Effect<void>
          return Effect.succeed({ dispose: Effect.void })
        },
        synthetic: (input) => {
          persisted.push(input.text)
          return Effect.succeed(
            SessionInbox.Synthetic.make({
              id: SessionMessage.ID.make("msg_plan_test"),
              sessionID,
              timeCreated: DateTime.makeUnsafe(0),
              type: "synthetic",
              payload: { text: input.text },
              delivery: "steer",
            }),
          )
        },
      },
    }),
  ).pipe(
    Effect.provideService(
      Location.Service,
      Location.Service.of(
        location(Location.Ref.make({ directory: WORKTREE }), {
          vcs: repo ? { type: "git", store: AbsolutePath.make(`${WORKTREE}/.git`) } : undefined,
        }),
      ),
    ),
  )
  if (!contextHook) return yield* Effect.die("plan plugin did not register a context hook")
  if (!toolHook) return yield* Effect.die("plan plugin did not register a tool hook")
  return { persisted, contextHook, toolHook, rules }
})

const request = (agent: Agent.ID, messages: Array<Message>): SessionContext => ({
  sessionID,
  agent,
  model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") },
  system: [],
  messages,
  tools: {},
})

const settle = (persisted: ReadonlyArray<string>, expected: number, remaining = 1000): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    if (persisted.length >= expected) return
    if (remaining === 0) {
      return yield* Effect.fail(new Error(`Timed out waiting for ${expected} reminders, saw ${persisted.length}`))
    }
    yield* Effect.promise(() => Bun.sleep(1))
    yield* settle(persisted, expected, remaining - 1)
  })

/** The exact reminder texts, derived from plugin behavior rather than duplicated here. */
const reminders = Effect.gen(function* () {
  const planRun = yield* run()
  yield* planRun.contextHook(request(plan, []))
  const buildRun = yield* run()
  yield* buildRun.contextHook(request(build, [Message.user(planRun.persisted[0]!)]))
  return { enter: planRun.persisted[0]!, leave: buildRun.persisted[0]! }
})

describe("plan plugin reminders", () => {
  it.effect("injects enter and leave reminders on agent switches", () =>
    Effect.gen(function* () {
      const { persisted } = yield* run([agentSelected(plan, build), agentSelected(build, plan)])
      yield* settle(persisted, 2)
      expect(persisted[0]).toContain("You are in Plan mode")
      expect(persisted[1]).toContain("NO LONGER in Plan mode")
    }),
  )

  it.effect("reconciles a missing enter reminder into the request and persists it", () =>
    Effect.gen(function* () {
      const { persisted, contextHook } = yield* run()
      const messages = [Message.user("what agent are you?")]
      yield* contextHook(request(plan, messages))
      expect(messages).toHaveLength(2)
      // Inserted before the user's prompt, matching where agent-switch reminders land.
      const first = messages[0]?.content[0]
      expect(first?.type === "text" && first.text).toContain("You are in Plan mode")
      expect(persisted).toHaveLength(1)
    }),
  )

  it.effect("does nothing when the transcript already has a live enter reminder", () =>
    Effect.gen(function* () {
      const { enter } = yield* reminders
      const { persisted, contextHook } = yield* run()
      const messages = [Message.user(enter), Message.user("hello")]
      yield* contextHook(request(plan, messages))
      expect(messages).toHaveLength(2)
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("reconciles a stale enter reminder with a leave reminder", () =>
    Effect.gen(function* () {
      const { enter } = yield* reminders
      const { persisted, contextHook } = yield* run()
      const messages = [Message.user(enter), Message.user("ok implement it")]
      yield* contextHook(request(build, messages))
      expect(messages).toHaveLength(3)
      const middle = messages[1]?.content[0]
      expect(middle?.type === "text" && middle.text).toContain("NO LONGER in Plan mode")
      expect(persisted).toHaveLength(1)
    }),
  )

  it.effect("does nothing for non-plan sessions without plan history", () =>
    Effect.gen(function* () {
      const { persisted, contextHook } = yield* run()
      const messages = [Message.user("hello")]
      yield* contextHook(request(build, messages))
      expect(messages).toHaveLength(1)
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("does nothing when a leave reminder already follows the enter reminder", () =>
    Effect.gen(function* () {
      const { enter, leave } = yield* reminders
      const { persisted, contextHook } = yield* run()
      const messages = [Message.user(enter), Message.user(leave), Message.user("continue")]
      yield* contextHook(request(build, messages))
      expect(messages).toHaveLength(3)
      expect(persisted).toHaveLength(0)
    }),
  )

  it.effect("treats reminder text quoted inside a larger message as not live", () =>
    Effect.gen(function* () {
      const { enter } = yield* reminders
      const { persisted, contextHook } = yield* run()
      // Mirrors a compaction checkpoint quoting the reminder inside <recent-context>.
      const messages = [Message.user(`<conversation-checkpoint>\n${enter}\n</conversation-checkpoint>`)]
      yield* contextHook(request(plan, messages))
      expect(messages).toHaveLength(2)
      expect(persisted).toHaveLength(1)
    }),
  )
})

// REDSUN: plan mode is read-only except for the plan directory, and it cannot
// be delegated around.
describe("plan plugin file access", () => {
  const refused = (input: { tool: string; agent: Agent.ID; input: unknown }) =>
    Effect.gen(function* () {
      const { toolHook } = yield* run()
      return yield* toolHook(input).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      )
    })

  it.effect("refuses a write outside the plan directory", () =>
    Effect.gen(function* () {
      const message = yield* refused({ tool: "write", agent: plan, input: { path: "src/index.ts" } })
      expect(message).toContain("read-only mode")
      expect(message).toContain("plans")
    }),
  )

  it.effect("allows a write to the project's plan directory", () =>
    Effect.gen(function* () {
      expect(yield* refused({ tool: "write", agent: plan, input: { path: ".redsun/plans/2026-feature.md" } })).toBe(
        undefined,
      )
      expect(yield* refused({ tool: "edit", agent: plan, input: { path: ".redsun/plans/2026-feature.md" } })).toBe(
        undefined,
      )
    }),
  )

  it.effect("refuses a plan-directory escape dressed up as one", () =>
    Effect.gen(function* () {
      // `.redsun/plans/../../src` normalizes out of the directory entirely.
      expect(
        yield* refused({ tool: "write", agent: plan, input: { path: ".redsun/plans/../../src/index.ts" } }),
      ).toContain("read-only mode")
    }),
  )

  it.effect("refuses a patch when any hunk leaves the plan directory", () =>
    Effect.gen(function* () {
      const hunks = [{ path: ".redsun/plans/a.md" }, { path: "src/index.ts" }]
      expect(yield* refused({ tool: "patch", agent: plan, input: { hunks } })).toContain("read-only mode")
      expect(yield* refused({ tool: "patch", agent: plan, input: { hunks: [hunks[0]] } })).toBe(undefined)
      // A rename out of the directory is still a write out of the directory.
      expect(
        yield* refused({
          tool: "patch",
          agent: plan,
          input: { hunks: [{ path: ".redsun/plans/a.md", movePath: "src/a.md" }] },
        }),
      ).toContain("read-only mode")
    }),
  )

  it.effect("refuses shell outright, whatever the command", () =>
    Effect.gen(function* () {
      // Read-only has to include the shell, or `sed -i` walks straight around the
      // edit/write/patch refusals above.
      for (const command of ["ls", "rm -rf build", "sed -i 's/a/b/' src/index.ts"]) {
        const message = yield* refused({ tool: "shell", agent: plan, input: { command } })
        expect(message).toContain("read-only mode")
        expect(message).toContain("shell")
      }
    }),
  )

  it.effect("leaves other agents and other tools alone", () =>
    Effect.gen(function* () {
      expect(yield* refused({ tool: "write", agent: build, input: { path: "src/index.ts" } })).toBe(undefined)
      expect(yield* refused({ tool: "read", agent: plan, input: { path: "src/index.ts" } })).toBe(undefined)
      expect(yield* refused({ tool: "shell", agent: build, input: { command: "rm -rf build" } })).toBe(undefined)
    }),
  )

  it.effect("denies delegation, so read-only cannot be handed to a subagent", () =>
    Effect.gen(function* () {
      const { rules } = yield* run()
      expect(rules).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
    }),
  )

  it.effect("falls back to the global plan directory without a repository", () =>
    Effect.gen(function* () {
      const { toolHook } = yield* run([], false)
      const message = yield* toolHook({ tool: "write", agent: plan, input: { path: ".redsun/plans/a.md" } }).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      )
      // Without a repo the in-repo path is not the plan directory.
      expect(message).toContain("read-only mode")
      expect(message).toContain("plans")
    }),
  )
})
