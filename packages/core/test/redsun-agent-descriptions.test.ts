import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { RedsunAgentDescriptions } from "@opencode/core/plugin/redsun/agent-descriptions"
import { AbsolutePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const testLocation = location({ directory: AbsolutePath.make("/project") })
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(testLocation))
const global = Global.make({ data: "/data", config: "/config", tmp: "/tmp/redsun" })
const globalLayer = Layer.succeed(Global.Service, Global.Service.of(global))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, Location.node]), [
    Global.node.replace(globalLayer),
    Location.node.replace(locationLayer),
  ]) as unknown as Layer.Layer<unknown, never>,
)

describe("RedsunAgentDescriptions", () => {
  it.effect("shortens the built-in subagent descriptions and leaves the agents otherwise unchanged", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agent) }))
      const before = yield* agent.get(Agent.ID.make("explore"))
      yield* RedsunAgentDescriptions.Plugin.effect(host({ agent: agentHost(agent) }))

      const explore = yield* agent.get(Agent.ID.make("explore"))
      const general = yield* agent.get(Agent.ID.make("general"))
      expect(explore?.description).toBe(RedsunAgentDescriptions.DESCRIPTIONS.explore)
      expect(general?.description).toBe(RedsunAgentDescriptions.DESCRIPTIONS.general)
      expect(explore?.description!.length).toBeLessThan(before!.description!.length)
      expect({ ...explore, description: undefined }).toEqual({ ...before, description: undefined })
    }),
  )
})
