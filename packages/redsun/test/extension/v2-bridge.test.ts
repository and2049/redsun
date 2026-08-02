import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationError, LocationServices } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import type { SessionMessage } from "@opencode-ai/core/session/message"
import type { SessionSchema } from "@opencode-ai/core/session/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import type { AgentV2 } from "@opencode-ai/core/agent"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Context, Effect, Layer, type LayerMap } from "effect"
import { ExtensionRuntime } from "../../src/extension/runtime"
import { ExtensionV2Bridge } from "../../src/extension/v2-bridge"
import { adaptTool } from "../../src/extension/v2-tool-adapter"
import { pollWithTimeout, testEffect } from "../lib/effect"

const directory = mkdtempSync(path.join(os.tmpdir(), "redsun-v2-bridge-"))

let locationContext = Context.empty() as Context.Context<never>
const locations = Layer.succeed(
  LocationServiceMap.Service,
  { get: () => Layer.succeedContext(locationContext) } as unknown as LayerMap.LayerMap<
    Location.Ref,
    LocationServices,
    LocationError
  >,
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ExtensionV2Bridge.node, ToolRegistry.node, ToolRegistry.toolsNode, SystemContextRegistry.node]),
    [
      [Location.node, Location.boundNode({ directory: AbsolutePath.make(directory) })],
      [LocationServiceMap.node, locations],
    ],
  ),
)

const toolContext = {
  sessionID: "ses_bridge_test" as SessionSchema.ID,
  agent: "build" as AgentV2.ID,
  assistantMessageID: "msg_bridge_test" as SessionMessage.ID,
  toolCallID: "call_1",
}

async function createRuntime(source: string, scope: "user" | "project" = "user") {
  const file = path.join(directory, `ext-${crypto.randomUUID()}.ts`)
  await writeFile(file, source)
  const plugin = {
    directory,
    worktree: directory,
    project: {},
    client: { session: { promptAsync: async () => ({ data: undefined }) } },
  } as unknown as PluginInput
  await ExtensionRuntime.create({
    plugin,
    userEntries: scope === "user" ? [file] : [],
    projectEntries: scope === "project" ? [file] : [],
    defaultTrust: "never",
  })
}

const captureContext = Effect.gen(function* () {
  locationContext = (yield* Effect.context()) as Context.Context<never>
})

const toolNames = ToolRegistry.Service.use((registry) =>
  registry.materialize().pipe(Effect.map((materialized) => materialized.definitions.map((item) => item.name))),
)

describe("extension v2 bridge", () => {
  it.live("adapts an extension tool and maps results and errors", () =>
    Effect.gen(function* () {
      const tool = adaptTool(
        {
          description: "Echo",
          args: {},
          execute: async (_args, ctx) => ({ title: "echo", output: `ok:${ctx.sessionID}`, metadata: {} }),
        },
        { directory, worktree: directory },
      )
      const output = yield* Tool.settle(tool, { type: "tool-call", id: "call_1", name: "ext_echo", input: {} }, toolContext)
      expect(output.content).toEqual([{ type: "text", text: "ok:ses_bridge_test" }])

      const failing = adaptTool(
        {
          description: "Fail",
          args: {},
          execute: async () => ({ output: "boom", metadata: { isError: true } }),
        },
        { directory, worktree: directory },
      )
      const failure = yield* Tool.settle(
        failing,
        { type: "tool-call", id: "call_2", name: "ext_fail", input: {} },
        toolContext,
      ).pipe(Effect.flip)
      expect(failure.message).toBe("boom")
    }),
  )

  it.live("registers live extension tool changes into the v2 registry", () =>
    Effect.gen(function* () {
      yield* captureContext
      yield* Effect.promise(() =>
        createRuntime(`export default (api) => {
          api.registerCommand({
            name: "tools",
            handler: async (args) => {
              if (args === "remove") return api.unregisterTool("dynamic")
              await api.registerTool({
                id: "dynamic",
                init: () => ({
                  description: "dynamic tool",
                  parameters: { shape: {} },
                  execute: () => ({ title: "dynamic", output: "ok", metadata: {} }),
                }),
              })
            },
          })
        }`),
      )
      expect(yield* toolNames).not.toContain("dynamic")

      yield* Effect.promise(() => ExtensionRuntime.runCommand(directory, "tools", "add", "ses_bridge_test", "build"))
      yield* pollWithTimeout(
        toolNames.pipe(Effect.map((names) => (names.includes("dynamic") ? true : undefined))),
        "dynamic extension tool should reach the v2 registry",
      )

      yield* Effect.promise(() => ExtensionRuntime.runCommand(directory, "tools", "remove", "ses_bridge_test", "build"))
      yield* pollWithTimeout(
        toolNames.pipe(Effect.map((names) => (names.includes("dynamic") ? undefined : true))),
        "removed extension tool should leave the v2 registry",
      )
    }),
  )

  it.live("registers extension system-context sources", () =>
    Effect.gen(function* () {
      yield* captureContext
      yield* Effect.promise(() =>
        createRuntime(`export default (api) => {
          api.registerSystemContext("notes", () => "extension notes for v2")
        }`),
      )
      yield* ExtensionV2Bridge.Service.use((bridge) => bridge.attach(directory))
      const generation = yield* SystemContextRegistry.Service.use((registry) => registry.load()).pipe(
        Effect.flatMap(SystemContext.initialize),
      )
      expect(generation.baseline).toContain("extension notes for v2")
    }),
  )

  it.live("does not register project tools for denied projects", () =>
    Effect.gen(function* () {
      yield* captureContext
      const source = `export default async (api) => {
        await api.registerTool({
          id: "project_tool",
          init: () => ({
            description: "project tool",
            parameters: { shape: {} },
            execute: () => ({ output: "x", metadata: {} }),
          }),
        })
      }`
      yield* Effect.promise(() => createRuntime(source, "project"))
      yield* ExtensionV2Bridge.Service.use((bridge) => bridge.attach(directory))
      expect(yield* toolNames).not.toContain("project_tool")

      yield* Effect.promise(() => createRuntime(source, "user"))
      yield* ExtensionV2Bridge.Service.use((bridge) => bridge.attach(directory))
      expect(yield* toolNames).toContain("project_tool")
    }),
  )
})
