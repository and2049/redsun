import { describe, expect, test } from "bun:test"
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { SessionManager, type CreateQuery, type QueryLike } from "@/claude-code/sessions"

const sid = "22222222-2222-4222-8222-222222222222"

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

function text(value: string): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text: value }] },
    parent_tool_use_id: null,
    uuid: "u",
    session_id: sid,
  } as never
}

/**
 * Fake query: echoes one assistant message + result for every prompt pushed.
 */
function makeFakeQuery(record: {
  options: Options[]
  prompts: string[]
  interrupts: number
  closed: number
  models?: (string | undefined)[]
  modes?: string[]
}) {
  const createQuery: CreateQuery = ({ prompt, options }) => {
    record.options.push(options)
    let stopped = false
    const iterator = (async function* (): AsyncGenerator<SDKMessage, void> {
      if (typeof prompt === "string") {
        record.prompts.push(prompt)
        yield text(`echo: ${prompt}`)
        yield result()
        return
      }
      for await (const message of prompt) {
        if (stopped) return
        const content = (message as SDKUserMessage).message.content
        record.prompts.push(typeof content === "string" ? content : JSON.stringify(content))
        yield text(`echo`)
        yield result()
      }
    })()
    const query: QueryLike = {
      [Symbol.asyncIterator]: () => iterator,
      interrupt: async () => {
        record.interrupts++
      },
      setModel: async (model) => {
        record.models?.push(model)
      },
      setPermissionMode: async (mode) => {
        record.modes?.push(mode)
      },
      close: () => {
        stopped = true
        record.closed++
        void iterator.return?.()
      },
    }
    return query
  }
  return createQuery
}

async function collect(iterable: AsyncIterable<SDKMessage>) {
  const out: SDKMessage[] = []
  for await (const message of iterable) out.push(message)
  return out
}

const OPTS = { model: "opus", permissionMode: "default" as const, options: {} }

describe("claude-code session manager", () => {
  test("one process serves consecutive turns and each turn ends at result", async () => {
    const record = { options: [] as Options[], prompts: [] as string[], interrupts: 0, closed: 0 }
    const manager = new SessionManager(makeFakeQuery(record))

    const first = await collect(await manager.turn("s1", "first prompt", OPTS))
    expect(first.map((message) => message.type)).toEqual(["assistant", "result"])
    expect(manager.busy("s1")).toBe(false)

    const second = await collect(await manager.turn("s1", "second prompt", OPTS))
    expect(second.map((message) => message.type)).toEqual(["assistant", "result"])

    expect(record.options).toHaveLength(1)
    expect(record.prompts).toEqual(["first prompt", "second prompt"])
  })

  test("array content (text + image blocks) round-trips through the prompt queue", async () => {
    const record = { options: [] as Options[], prompts: [] as string[], interrupts: 0, closed: 0 }
    const manager = new SessionManager(makeFakeQuery(record))
    const content = [
      { type: "text" as const, text: "hi" },
      { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AAAA" } },
    ]
    await collect(await manager.turn("s1", content, OPTS))
    expect(record.prompts).toEqual([JSON.stringify(content)])
  })

  test("concurrent turn on the same session is rejected", async () => {
    const record = { options: [] as Options[], prompts: [] as string[], interrupts: 0, closed: 0 }
    const manager = new SessionManager(makeFakeQuery(record))
    const iterable = await manager.turn("s1", "first", OPTS)
    expect(manager.busy("s1")).toBe(true)
    await expect(manager.turn("s1", "second", OPTS)).rejects.toThrow("already processing")
    await collect(iterable)
  })

  test("interrupt reaches the live query", async () => {
    const record = { options: [] as Options[], prompts: [] as string[], interrupts: 0, closed: 0 }
    const manager = new SessionManager(makeFakeQuery(record))
    const iterable = await manager.turn("s1", "prompt", OPTS)
    await manager.interrupt("s1")
    expect(record.interrupts).toBe(1)
    await collect(iterable)
  })

  test("stopAll closes every live process", async () => {
    const record = { options: [] as Options[], prompts: [] as string[], interrupts: 0, closed: 0 }
    const manager = new SessionManager(makeFakeQuery(record))
    await collect(await manager.turn("s1", "a", OPTS))
    await collect(await manager.turn("s2", "b", OPTS))
    manager.stopAll()
    expect(record.closed).toBe(2)
  })

  test("switching agents changes the live process's permission mode in place", async () => {
    const record = {
      options: [] as Options[],
      prompts: [] as string[],
      interrupts: 0,
      closed: 0,
      modes: [] as string[],
    }
    const manager = new SessionManager(makeFakeQuery(record))
    await collect(await manager.turn("s1", "build turn", OPTS))
    await collect(await manager.turn("s1", "plan turn", { ...OPTS, permissionMode: "plan" }))
    await collect(await manager.turn("s1", "still plan", { ...OPTS, permissionMode: "plan" }))
    await collect(await manager.turn("s1", "back to build", OPTS))

    expect(record.options).toHaveLength(1)
    expect(record.modes).toEqual(["plan", "default"])
  })

  test("raising a live session to bypassPermissions restarts it with the resume cursor", async () => {
    const record = { options: [] as Options[], prompts: [] as string[], interrupts: 0, closed: 0, modes: [] as string[] }
    const manager = new SessionManager(makeFakeQuery(record))
    await collect(await manager.turn("s1", "first", { ...OPTS, options: { resume: "cc-session" } }))
    await collect(
      await manager.turn("s1", "second", {
        ...OPTS,
        permissionMode: "bypassPermissions",
        options: { resume: "cc-session" },
      }),
    )

    expect(record.closed).toBe(1)
    expect(record.options).toHaveLength(2)
    expect(record.modes).toEqual([])
    expect(record.options[1]).toMatchObject({
      resume: "cc-session",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    })
  })

  test("permission mode and model land in query options", async () => {
    const record = { options: [] as Options[], prompts: [] as string[], interrupts: 0, closed: 0 }
    const manager = new SessionManager(makeFakeQuery(record))
    await collect(
      await manager.turn("s1", "prompt", {
        model: "sonnet",
        permissionMode: "bypassPermissions",
        options: {},
      }),
    )
    expect(record.options[0]).toMatchObject({
      model: "sonnet",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
    })
  })
})
