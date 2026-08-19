import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { AgentPlugin } from "@opencode-ai/core/plugin/agent"
import { RedsunComposePlugin } from "@opencode-ai/core/plugin/redsun/compose"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/util/global"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const testLocation = location({ directory: AbsolutePath.make("/project") })
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(testLocation))
const global = Global.make({ data: "/data", config: "/config", tmp: "/tmp/redsun" })
const globalLayer = Layer.succeed(Global.Service, Global.Service.of(global))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, Location.node]), [
    [Global.node, globalLayer],
    [Location.node, locationLayer],
  ]) as unknown as Layer.Layer<unknown, never>,
)

// Mirrors Permission.resolve, which takes the LAST matching rule.
const effectFor = (rules: readonly Agent.Info["permissions"][number][], action: string, resource: string) =>
  rules.findLast((rule) => {
    const matches = (pattern: string, value: string) => pattern === "*" || pattern === value
    return matches(rule.action, action) && matches(rule.resource, resource)
  })?.effect

const load = Effect.fn(function* () {
  const agent = yield* Agent.Service
  yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) }))
  yield* RedsunComposePlugin.Plugin.effect(host({ agent: agentHost(agent) }))
  return agent
})

describe("RedsunComposePlugin", () => {
  it.effect("registers compose as a primary agent and worker as a subagent", () =>
    Effect.gen(function* () {
      const agent = yield* load()
      const compose = yield* agent.get(Agent.ID.make("compose"))
      const worker = yield* agent.get(Agent.ID.make("worker"))

      expect(compose?.mode).toBe("primary")
      expect(worker?.mode).toBe("subagent")
      expect(compose?.system).toContain("You are the compose agent")
      expect(worker?.system).toContain("You are a worker subagent")
    }),
  )

  it.effect("lets compose delegate only to worker and explore", () =>
    Effect.gen(function* () {
      const agent = yield* load()
      const rules = (yield* agent.get(Agent.ID.make("compose")))?.permissions ?? []

      expect(effectFor(rules, "subagent", "worker")).toBe("allow")
      expect(effectFor(rules, "subagent", "explore")).toBe("allow")
      // A subagent added upstream must not become reachable by default.
      expect(effectFor(rules, "subagent", "general")).toBe("deny")
      expect(effectFor(rules, "question", "*")).toBe("allow")
    }),
  )

  it.effect("fails a worker closed for questions and nested delegation", () =>
    Effect.gen(function* () {
      const agent = yield* load()
      const rules = (yield* agent.get(Agent.ID.make("worker")))?.permissions ?? []

      expect(effectFor(rules, "subagent", "worker")).toBe("deny")
      expect(effectFor(rules, "subagent", "explore")).toBe("deny")
      expect(effectFor(rules, "question", "*")).toBe("deny")
    }),
  )

  it.effect("leaves the upstream agent roster otherwise intact", () =>
    Effect.gen(function* () {
      const agent = yield* load()
      const agents = yield* agent.list()

      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "build",
        "compaction",
        "compose",
        "explore",
        "general",
        "summary",
        "title",
        "worker",
      ])
    }),
  )
})
