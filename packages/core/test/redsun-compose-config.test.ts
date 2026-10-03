import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { ModelsDev } from "@opencode/core/models-dev"
import { Permission } from "@opencode/core/permission"
import { PluginInternal } from "@opencode/core/plugin/internal"
import { Document, Event, Info } from "@opencode/schema/config"
import { tempLocationLayer } from "./fixture/location"
import { emptyMcpLayer } from "./fixture/mcp"
import { Mcp } from "@opencode/core/mcp/index"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const it = testEffect(
  AppNodeBuilder.build(PluginInternal.requirements, [
    Location.node.replace(tempLocationLayer),
    ModelsDev.node.replace(
      Layer.succeed(
        ModelsDev.Service,
        ModelsDev.Service.of({
          get: () => Effect.succeed([]),
          refresh: () => Effect.void,
        }),
      ),
    ),
    Mcp.node.replace(emptyMcpLayer),
    Config.node.replace(
      Config.testLayer([
        new Document({
          type: "document",
          info: Schema.decodeUnknownSync(Info)({
            permissions: [
              { action: "shell", resource: "*", effect: "ask" },
              { action: "shell", resource: "printf DENIED", effect: "deny" },
            ],
            agents: {
              worker: { system: "Configured worker instructions", model: "kiro/auto", mode: "subagent" },
            },
          }),
        }),
      ]),
    ),
  ]),
)

it.live("builtin compose and worker receive configured policy in production registration order", () =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service
    const plugins = yield* PluginInternal.list()
    const selected = new Set(["opencode.agent", "redsun.agent.compose", "opencode.config.agent"])
    const ctx = host({ agent: agentHost(agents), event: { subscribe: () => bus.subscribe(Event.Updated) } })
    for (const plugin of [...plugins.pre, ...plugins.post]) if (selected.has(plugin.id)) yield* plugin.effect(ctx)

    for (const id of ["compose", "worker"]) {
      const agent = yield* agents.get(Agent.ID.make(id))
      expect(agent).toBeDefined()
      expect(Permission.evaluate("shell", "printf OK", agent!.permissions).effect).toBe("ask")
      expect(Permission.evaluate("shell", "printf DENIED", agent!.permissions).effect).toBe("deny")
    }
    expect(yield* agents.get(Agent.ID.make("worker"))).toMatchObject({
      system: "Configured worker instructions",
      model: { providerID: "kiro", id: "auto" },
      mode: "subagent",
    })
  }),
)
