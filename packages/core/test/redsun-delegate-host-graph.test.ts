import { describe, expect } from "bun:test"
import { Effect, Option } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Credential } from "@opencode/core/credential"
import { FileSystem } from "@opencode/core/filesystem"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Form } from "@opencode/core/form"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { PluginHost } from "@opencode/core/plugin/host"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Npm } from "@opencode/util/npm"
import { AppProcess } from "@opencode/util/process"
import { Global } from "@opencode/util/global"
import { tempLocationLayer } from "./fixture/location"
import { emptyMcpLayer } from "./fixture/mcp"
import { testEffect } from "./lib/effect"

// REDSUN: regression for a live failure. The delegate domain acquires Config, Form and
// InstructionDiscovery optionally, so a host built from a graph that lacks them fails only when a
// runtime calls the capability. Build the host from the production requirements graph (the one
// `Plugin.node` depends on) and call each capability.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      PluginHost.requirements,
      AppProcess.node,
      FileSystem.node,
      FSUtil.node,
      Npm.node,
      Credential.node,
      LayerNodePlatform.httpClient,
    ]),
    [
      Location.node.replace(tempLocationLayer),
      Config.node.replace(Config.testLayer()),
      Mcp.node.replace(emptyMcpLayer),
    ],
  ),
)

describe("delegate host in the production plugin graph", () => {
  it.effect("provides config, forms and instruction discovery", () =>
    Effect.gen(function* () {
      for (const service of [Config.Service, Form.Service, InstructionDiscovery.Service])
        expect(Option.isSome(yield* Effect.serviceOption(service as never))).toBe(true)
      const host = yield* PluginHost.make({ list: () => Effect.succeed([]) } as never)
      expect(yield* host.delegate.config("instruction_max_chars")).toBeUndefined()
      const location = yield* Location.Service
      const global = yield* Global.Service
      expect(yield* host.delegate.context.environment()).toEqual({
        directory: location.directory,
        workspaceRoot: location.project.directory,
        temporaryDirectory: global.tmp,
      })
      const files = yield* host.delegate.context.instructions()
      expect(files === undefined || Array.isArray(files)).toBe(true)
      // The graph provides the environment builtins the base prompt's dynamic part needs.
      const missing = yield* host.delegate.context
        .system({ sessionID: "ses_graph", agent: "no-such-agent", tools: ["read"] })
        .pipe(Effect.flip)
      expect(missing.message).toContain("no-such-agent")
      expect(Option.isSome(yield* Effect.serviceOption(InstructionBuiltIns.Service as never))).toBe(true)
    }),
  )
})
