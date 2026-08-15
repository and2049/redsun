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
import { Effect, Fiber, Layer, Stream } from "effect"
import { ClaudeCode } from "@/claude-code/runtime"
import { ClaudeCodeModes } from "@/claude-code/modes"
import type { CreateQuery, QueryLike } from "@/claude-code/sessions"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
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
  interrupts: number
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
      interrupt: async () => {
        record.interrupts++
      },
      setModel: async () => {},
      setPermissionMode: async (mode) => {
        record.modes.push(mode)
      },
      close: () => void iterator.return?.(),
    }
    return query
  }
}

/** Replays a fixed frame script per prompt — including frames past the turn's result. */
function scripted(script: SDKMessage[], record: Record_): CreateQuery {
  return ({ prompt, options }) => {
    record.options.push(options)
    const iterator = (async function* (): AsyncGenerator<SDKMessage, void> {
      if (typeof prompt === "string") {
        record.prompts.push(prompt)
        yield* script
        return
      }
      for await (const message of prompt) {
        const content = message.message.content
        record.prompts.push(typeof content === "string" ? content : JSON.stringify(content))
        yield* script
      }
    })()
    const query: QueryLike = {
      [Symbol.asyncIterator]: () => iterator,
      interrupt: async () => {
        record.interrupts++
      },
      setModel: async () => {},
      setPermissionMode: async () => {},
      close: () => void iterator.return?.(),
    }
    return query
  }
}

/**
 * Records prompts but never completes a turn until `interrupt()` arrives;
 * `onDeliver` fires once the prompt has reached the fake process.
 */
function hangingRecorder(record: Record_, onDeliver: () => void): CreateQuery {
  return ({ prompt, options }) => {
    record.options.push(options)
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    const iterator = (async function* (): AsyncGenerator<SDKMessage, void> {
      if (typeof prompt === "string") return
      for await (const message of prompt) {
        const content = message.message.content
        record.prompts.push(typeof content === "string" ? content : JSON.stringify(content))
        onDeliver()
        await released
        yield result()
      }
    })()
    const query: QueryLike = {
      [Symbol.asyncIterator]: () => iterator,
      interrupt: async () => {
        record.interrupts++
        release()
      },
      setModel: async () => {},
      setPermissionMode: async () => {},
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

/** Everything the runtime authored through Session/SessionStatus. */
interface MirrorSink {
  messages: Record<string, any>[]
  parts: Record<string, any>[]
  statuses: { sessionID: string; status: { type: string } }[]
}

function sessionLayer(sink?: MirrorSink) {
  return Layer.succeed(Session.Service, {
    create: () => Effect.succeed({ id: "ses_subagent_child" }),
    touch: () => Effect.void,
    updateMessage: (msg: Record<string, any>) =>
      Effect.sync(() => {
        sink?.messages.push(structuredClone(msg))
        return msg
      }),
    updatePart: (part: Record<string, any>) =>
      Effect.sync(() => {
        sink?.parts.push(structuredClone(part))
        return part
      }),
  } as never)
}

function sessionStatusLayer(sink?: MirrorSink) {
  return Layer.succeed(SessionStatus.Service, {
    get: () => Effect.succeed({ type: "idle" }),
    list: () => Effect.succeed(new Map()),
    set: (sessionID: string, status: { type: string }) => Effect.sync(() => void sink?.statuses.push({ sessionID, status })),
  } as never)
}

function runtimeLayer(createQuery: CreateQuery, config: Partial<ConfigV1.Info>, sink?: MirrorSink) {
  return AppNodeBuilder.build(
    LayerNode.make({
      service: ClaudeCode.Service,
      layer: ClaudeCode.layerWith(createQuery),
      deps: [Config.node, Storage.node, Permission.node, Question.node, Session.node, SessionStatus.node],
    }),
    [
      [Config.node, Layer.succeed(Config.Service, TestConfig.make({ get: () => Effect.succeed(config) }))],
      [Storage.node, storageLayer()],
      [Permission.node, permissionLayer],
      [Question.node, questionLayer],
      [Session.node, sessionLayer(sink)],
      [SessionStatus.node, sessionStatusLayer(sink)],
    ],
  )
}

const model = { id: "sonnet", providerID: "claude-code" }

function request(input: {
  agent: { name: string; mode?: string; prompt?: string }
  text?: string
  messages?: unknown[]
  tools?: Record<string, AiTool>
  parentSessionID?: string
  sessionID?: string
  small?: boolean
}) {
  return {
    user: { id: "msg_parent_user" },
    sessionID: input.sessionID ?? "ses_modes",
    parentSessionID: input.parentSessionID,
    model,
    agent: { mode: "primary", permission: [], ...input.agent },
    permission: [],
    system: ["redsun system prompt"],
    messages: input.messages ?? [{ role: "user" as const, content: input.text ?? "" }],
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
  makeQuery: (record: Record_) => CreateQuery = recorder,
  sink?: MirrorSink,
) =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const binary = yield* fakeBinary(instance.directory)
    const record: Record_ = { options: [], prompts: [], modes: [], interrupts: 0 }
    const turn = (input: Parameters<typeof request>[0]) =>
      Effect.gen(function* () {
        const claude = yield* ClaudeCode.Service
        yield* Stream.runDrain(claude.stream(request(input))).pipe(Effect.orDie)
      })
    return yield* body({ record, turn }).pipe(Effect.provide(runtimeLayer(makeQuery(record), config(binary), sink)))
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

  it.instance("interactive sessions forward subagent conversations for the mirror", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({ agent: { name: "build" }, text: "hello" })
        expect(record.options[0]).toMatchObject({ forwardSubagentText: true, includePartialMessages: true })
      }),
    ),
  )

  it.instance("manual compaction of a live session sends the CLI's /compact command", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({ agent: { name: "custom", prompt: "CUSTOM BRIEF" }, text: "one" })
        yield* turn({ agent: { name: "custom", prompt: "CUSTOM BRIEF" }, text: "two" })
        yield* turn({ agent: { name: "compaction" }, text: "Summarize this conversation." })
        yield* turn({ agent: { name: "custom", prompt: "CUSTOM BRIEF" }, text: "three" })
        // The summarize prompt never reaches the CLI, and the agent brief is
        // re-sent after compaction dropped it from the session history.
        expect(record.prompts).toEqual([
          "CUSTOM BRIEF\n\none",
          "two",
          "/compact",
          "CUSTOM BRIEF\n\nthree",
        ])
      }),
    ),
  )

  it.instance("compaction without a live Claude session falls back to the summarize prompt", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({ agent: { name: "compaction" }, text: "Summarize this conversation." })
        expect(record.prompts).toEqual(["Summarize this conversation."])
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

  it.instance("image attachments are delivered as base64 image blocks after the text", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({
          agent: { name: "build" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "see [Image 1]" },
                { type: "file", mediaType: "image/png", filename: "shot.png", data: "data:image/png;base64,AAAA" },
              ],
            },
          ],
        })
        expect(JSON.parse(record.prompts[0]!)).toEqual([
          { type: "text", text: "see [Image 1]" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ])
      }),
    ),
  )

  it.instance("pdf attachments become document blocks titled with the filename", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({
          agent: { name: "build" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "read [PDF 1]" },
                { type: "file", mediaType: "application/pdf", filename: "doc.pdf", data: "data:application/pdf;base64,BBBB" },
              ],
            },
          ],
        })
        expect(JSON.parse(record.prompts[0]!)).toEqual([
          { type: "text", text: "read [PDF 1]" },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "BBBB" }, title: "doc.pdf" },
        ])
      }),
    ),
  )

  it.instance("unsupported attachment mimes degrade to a text placeholder instead of failing", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({
          agent: { name: "build" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "listen" },
                { type: "file", mediaType: "audio/mpeg", filename: "clip.mp3", data: "data:audio/mpeg;base64,CCCC" },
              ],
            },
          ],
        })
        expect(JSON.parse(record.prompts[0]!)).toEqual([
          { type: "text", text: "listen" },
          { type: "text", text: "[Attached audio/mpeg: clip.mp3]" },
        ])
      }),
    ),
  )

  it.instance("attachments behind the last assistant message are not re-sent", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({
          agent: { name: "build" },
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "see [Image 1]" },
                { type: "file", mediaType: "image/png", filename: "shot.png", data: "data:image/png;base64,AAAA" },
              ],
            },
            { role: "assistant", content: "described it" },
            { role: "user", content: "next" },
          ],
        })
        expect(record.prompts).toEqual(["next"])
      }),
    ),
  )

  it.instance("one-shot internal calls carry attachments via the streaming prompt", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({
          agent: { name: "build" },
          small: true,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "judge this" },
                { type: "file", mediaType: "image/png", filename: "shot.png", data: "data:image/png;base64,AAAA" },
              ],
            },
          ],
        })
        expect(JSON.parse(record.prompts[0]!)).toEqual([
          { type: "text", text: "user: judge this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ])
      }),
    ),
  )

  it.instance("a completed turn never sends an interrupt", () =>
    withRuntime(({ record, turn }) =>
      Effect.gen(function* () {
        yield* turn({ agent: { name: "build" }, text: "quick task" })
        expect(record.interrupts).toBe(0)
      }),
    ),
  )

  it.instance("frames after the turn's result still reach the subagent mirror", () => {
    // Async-launched subagents: the CLI ends the main turn immediately and
    // everything else — child frames, the settling notification, the main
    // thread's auto-continuation — arrives between turn windows. The pump's
    // observer must deliver all of it to the mirror instead of dropping it.
    const sink: MirrorSink = { messages: [], parts: [], statuses: [] }
    const script = [
      {
        type: "assistant",
        message: {
          id: "m1",
          content: [
            {
              type: "tool_use",
              id: "task_1",
              name: "Task",
              input: { description: "Scan", prompt: "go", subagent_type: "Explore" },
            },
          ],
        },
        parent_tool_use_id: null,
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "task_1", content: "launched" }] },
        parent_tool_use_id: null,
        tool_use_result: { status: "async_launched" },
      },
      result(),
      {
        type: "assistant",
        message: { id: "sub_m1", content: [{ type: "text", text: "child working" }] },
        parent_tool_use_id: "task_1",
      },
      { type: "system", subtype: "task_notification", tool_use_id: "task_1", status: "completed", summary: "found it" },
      {
        type: "assistant",
        message: { id: "cont_m1", content: [{ type: "text", text: "the findings" }] },
        parent_tool_use_id: null,
      },
      result(),
    ] as SDKMessage[]
    return withRuntime(
      ({ turn }) =>
        Effect.gen(function* () {
          yield* turn({ agent: { name: "build" }, text: "kick off" })
          // The turn stream ended at the first result; the rest flows through
          // the pump between turns. Wait for it to land.
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 2_000
            while (Date.now() < deadline) {
              const idle = sink.statuses.some(
                (entry) => entry.sessionID === "ses_subagent_child" && entry.status.type === "idle",
              )
              const childText = sink.parts.some(
                (part) => part.sessionID === "ses_subagent_child" && part.text === "child working",
              )
              const continuation = sink.parts.some(
                (part) => part.sessionID === "ses_modes" && part.text === "the findings",
              )
              if (idle && childText && continuation) return
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
            throw new Error(
              `between-turn frames were dropped: ${JSON.stringify({
                statuses: sink.statuses,
                parts: sink.parts.map((part) => ({ type: part.type, sessionID: part.sessionID, text: part.text })),
              })}`,
            )
          })
          // The authored continuation is anchored to the turn's user message.
          const continuation = sink.messages.find(
            (msg) => msg.role === "assistant" && msg.sessionID === "ses_modes",
          )
          expect(continuation).toMatchObject({ parentID: "msg_parent_user", agent: "build" })
        }),
      undefined,
      (record) => scripted(script, record),
      sink,
    )
  })

  it.instance("fiber interruption sends the SDK interrupt and frees the session for the next turn", () => {
    let deliver!: () => void
    const delivered = new Promise<void>((resolve) => (deliver = resolve))
    return withRuntime(
      ({ record, turn }) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(turn({ agent: { name: "build" }, text: "long task" }))
          yield* Effect.promise(() => delivered)
          yield* Fiber.interrupt(fiber)
          expect(record.interrupts).toBe(1)
          // Give the pump a beat to consume the interrupt's result message and
          // clear the busy turn before prompting again.
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
          yield* turn({ agent: { name: "build" }, text: "after interrupt" })
          expect(record.prompts).toEqual(["long task", "after interrupt"])
        }),
      undefined,
      (record) => hangingRecorder(record, () => deliver()),
    )
  })
})
