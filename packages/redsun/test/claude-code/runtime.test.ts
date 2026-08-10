import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { Tool as AiTool } from "ai"
import { Effect, Layer, Stream } from "effect"
import { ClaudeCode } from "@/claude-code/runtime"
import { ClaudeCodeModes } from "@/claude-code/modes"
import type { CreateQuery, QueryLike } from "@/claude-code/sessions"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Question } from "@/question"
import { Storage } from "@/storage/storage"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const sid = "33333333-3333-4333-8333-333333333333"

function result(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    usage: { input_tokens: 1, output_tokens: 1 },
    session_id: sid,
    uuid: "u",
  } as never
}

interface Record_ {
  options: Options[]
  prompts: string[]
  modes: string[]
}

/** Records what the runtime hands to the SDK, then completes each turn. */
function recorder(record: Record_): CreateQuery {
  return ({ prompt, options }) => {
    record.options.push(options)
    const iterator = (async function* (): AsyncGenerator<SDKMessage, void> {
      if (typeof prompt === "string") {
        record.prompts.push(prompt)
        yield result()
        return
      }
      for await (const message of prompt) {
        const content = message.message.content
        record.prompts.push(typeof content === "string" ? content : JSON.stringify(content))
        yield result()
      }
    })()
    const query: QueryLike = {
      [Symbol.asyncIterator]: () => iterator,
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async (mode) => {
        record.modes.push(mode)
      },
      close: () => void iterator.return?.(),
    }
    return query
  }
}

function storageLayer() {
  const store = new Map<string, unknown>()
  return Layer.succeed(Storage.Service, {
    read: (key: string[]) =>
      store.has(key.join("/")) ? Effect.succeed(store.get(key.join("/"))) : Effect.fail(new Error("missing")),
    write: (key: string[], content: unknown) => Effect.sync(() => void store.set(key.join("/"), content)),
    update: () => Effect.fail(new Error("unused")),
    remove: (key: string[]) => Effect.sync(() => void store.delete(key.join("/"))),
    list: () => Effect.succeed([]),
  } as never)
}

const permissionLayer = Layer.succeed(Permission.Service, {
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} as never)

const questionLayer = Layer.succeed(Question.Service, {
  ask: () => Effect.succeed([]),
  reply: () => Effect.void,
  reject: () => Effect.void,
  list: () => Effect.succeed([]),
} as never)

function runtimeLayer(createQuery: CreateQuery, config: Partial<ConfigV1.Info>) {
  return AppNodeBuilder.build(
    LayerNode.make({
      service: ClaudeCode.Service,
      layer: ClaudeCode.layerWith(createQuery),
      deps: [Config.node, Storage.node, Permission.node, Question.node],
    }),
    [
      [Config.node, Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed(config) }))],
      [Storage.node, storageLayer()],
      [Permission.node, permissionLayer],
      [Question.node, questionLayer],
    ],
  )
}

const model = { id: "sonnet", providerID: "claude-code" }

function request(input: {
  agent: { name: string; mode?: string; prompt?: string }
  text: string
  tools?: Record<string, AiTool>
  parentSessionID?: string
  sessionID?: string
  small?: boolean
}) {
  return {
    user: {},
    sessionID: input.sessionID ?? "ses_modes",
    parentSessionID: input.parentSessionID,
    model,
    agent: { mode: "primary", permission: [], ...input.agent },
    permission: [],
    system: ["redsun system prompt"],
    messages: [{ role: "user" as const, content: input.text }],
    tools: input.tools ?? {},
    small: input.small,
    abort: new AbortController().signal,
  } as never
}

/** A file the executable resolver accepts without a real Claude Code install. */
const fakeBinary = (dir: string) =>
  Effect.gen(function* () {
    const binary = path.join(dir, process.platform === "win32" ? "claude-fake.exe" : "claude-fake")
    yield* Effect.promise(() => fs.writeFile(binary, ""))
    return binary
  })

/**
 * Drives real delegated turns against a fake SDK query, so the assertions
 * cover the options the runtime actually builds.
 */
const withRuntime = <A, E, R>(
  body: (input: {
    record: Record_
    turn: (input: Parameters<typeof request>[0]) => Effect.Effect<void, never, ClaudeCode.Service>
  }) => Effect.Effect<A, E, R>,
  config: (binary: string) => Partial<ConfigV1.Info> = (binary) => ({ claude_code: { binary_path: binary } }),
) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const binary = yield* fakeBinary(instance.directory)
    const record: Record_ = { options: [], prompts: [], modes: [] }
    const turn = (input: Parameters<typeof request>[0]) =>
      Effect.gen(function* () {
        const claude = yield* ClaudeCode.Service
        yield* Stream.runDrain(claude.stream(request(input))).pipe(Effect.orDie)
      })
    return yield* body({ record, turn }).pipe(Effect.provide(runtimeLayer(recorder(record), config(binary))))
  })

describe("claude-code delegated runtime", () => {
  it.instance("build turns use the configured permission mode and carry no mode brief", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({ agent: { name: "build" }, text: "add a test" })
        expect(record.options).toHaveLength(1)
        expect(record.options[0]).toMatchObject({ permissionMode: "acceptEdits" })
        expect(record.prompts).toEqual(["add a test"])
      }),
    (binary) => ({ claude_code: { binary_path: binary, permission_mode: "acceptEdits" } })),
  )

  it.instance("plan turns force Claude Code's plan mode over the configured mode", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({ agent: { name: "plan" }, text: "plan the refactor" })
        expect(record.options[0]).toMatchObject({ permissionMode: "plan" })
        expect(String(record.options[0]?.planModeInstructions)).toContain("Plan Workflow")
      }),
    (binary) => ({ claude_code: { binary_path: binary, permission_mode: "bypassPermissions" } })),
  )

  it.instance("switching build -> plan -> build flips the live process's mode without restarting", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({ agent: { name: "build" }, text: "one" })
        yield* turn({ agent: { name: "plan" }, text: "two" })
        yield* turn({ agent: { name: "build" }, text: "three" })
        expect(record.options).toHaveLength(1)
        expect(record.modes).toEqual(["plan", "default"])
      }),
    ),
  )

  it.instance("compose turns brief the model onto redsun's routed task tool", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({ agent: { name: "compose" }, text: "ship the feature", tools: { task: {} as AiTool } })
        expect(record.prompts[0]).toContain(ClaudeCodeModes.TASK_TOOL)
        expect(record.prompts[0]).toContain("ship the feature")
      }),
    ),
  )

  it.instance("worker sessions inherit the worker permission mode and are told not to delegate", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({
          agent: { name: "worker", mode: "subagent" },
          text: "do the scoped work",
          parentSessionID: "ses_parent",
        })
        expect(record.options[0]).toMatchObject({ permissionMode: "acceptEdits" })
        expect(record.prompts[0]).toContain("Do not delegate further")
      }),
    (binary) => ({
      claude_code: { binary_path: binary, permission_mode: "default", worker_permission_mode: "acceptEdits" },
    })),
  )

  it.instance("the routed task MCP server is attached even when the turn has no task tool", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({ agent: { name: "build" }, text: "hello" })
        expect(Object.keys(record.options[0]?.mcpServers ?? {})).toEqual(["redsun"])
      }),
    ),
  )

  it.instance("every spawned query targets the resolved CLI, never the SDK's bundled one", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({ agent: { name: "build" }, text: "interactive turn" })
        yield* turn({ agent: { name: "build" }, text: "internal call", small: true })
        expect(record.options).toHaveLength(2)
        for (const options of record.options) {
          expect(String(options.pathToClaudeCodeExecutable)).toContain("claude-fake")
        }
      }),
    ),
  )
})
