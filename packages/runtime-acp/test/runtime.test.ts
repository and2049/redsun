import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type { DelegatedPermissionCheck, DelegatedToolBinding, DelegatedTurn } from "@opencode/plugin/effect/delegate"
import { AcpHostTools } from "../src/host-tools.js"
import type { AcpOptions } from "../src/options.js"
import { AcpRuntime } from "../src/runtime.js"

const agent = (extra: Partial<AcpOptions.Agent> = {}): AcpOptions.Agent => ({
  id: "fake",
  name: "Fake ACP",
  command: process.execPath,
  args: [path.join(import.meta.dir, "fixture/agent.ts")],
  env: {},
  models: [{ id: "default", name: "Fake ACP" }],
  ...extra,
})

const host = (
  input: {
    mode?: "normal" | "auto" | "native_auto"
    approve?: boolean
    tools?: () => DelegatedToolBinding | undefined
  } = {},
) => {
  const checks: DelegatedPermissionCheck[] = []
  return {
    checks,
    host: {
      cwd: import.meta.dir,
      mode: async () => input.mode ?? "normal",
      approve: async (check: DelegatedPermissionCheck) => {
        checks.push(check)
        return input.approve ?? true
      },
      tools: async () => input.tools?.(),
    } satisfies AcpRuntime.Host,
  }
}

const TURN: DelegatedTurn = { sessionID: "ses_1", agent: "build", kind: "primary", modelID: "default" }

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] })

const call = (prompt: LanguageModelV3CallOptions["prompt"], extra: Partial<LanguageModelV3CallOptions> = {}) =>
  ({ prompt, ...extra }) as LanguageModelV3CallOptions

const collect = async (stream: ReadableStream<LanguageModelV3StreamPart>) => {
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

const textOf = (parts: readonly LanguageModelV3StreamPart[]) =>
  parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")

const withRuntime = async (
  input: { agent?: Partial<AcpOptions.Agent>; host?: Parameters<typeof host>[0] },
  body: (runtime: AcpRuntime.Runtime, checks: DelegatedPermissionCheck[]) => Promise<void>,
) => {
  const made = host(input.host)
  const runtime = new AcpRuntime.Runtime(agent(input.agent), made.host)
  try {
    await body(runtime, made.checks)
  } finally {
    runtime.stop()
  }
}

describe("ACP runtime against a scripted agent", () => {
  test("streams text as one block and finishes with the agent's usage", () =>
    withRuntime({}, async (runtime) => {
      const parts = await collect((await runtime.turn(TURN, call([user("hello")]))).stream)
      expect(textOf(parts)).toBe("Hello from the fake agent")
      expect(parts.filter((part) => part.type === "text-start")).toHaveLength(1)
      expect(parts.at(-1)).toMatchObject({
        type: "finish",
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: { inputTokens: { total: 1234 } },
      })
    }))

  test("reports the agent's tools as provider-executed calls settled by the agent", () =>
    withRuntime({}, async (runtime) => {
      const parts = await collect((await runtime.turn(TURN, call([user("think then use a tool")]))).stream)
      expect(parts.find((part) => part.type === "reasoning-delta")).toMatchObject({ delta: "pondering" })
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
        toolCallId: "call_read",
        toolName: "read",
        input: JSON.stringify({ path: "README.md" }),
        providerExecuted: true,
      })
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
        toolCallId: "call_read",
        toolName: "read",
        result: "# readme body",
      })
    }))

  test("asks the host before the agent edits, and relays its decision", async () => {
    await withRuntime({ host: { approve: true } }, async (runtime, checks) => {
      const parts = await collect((await runtime.turn(TURN, call([user("permission please")]))).stream)
      expect(textOf(parts)).toBe("ALLOWED")
      expect(checks).toEqual([
        {
          sessionID: "ses_1",
          agent: "build",
          action: "edit",
          resources: ["src/a.ts"],
          metadata: { source: "acp", toolCallId: "call_edit", title: "Edit src/a.ts" },
        },
      ])
    })
    await withRuntime({ host: { approve: false } }, async (runtime) => {
      const parts = await collect((await runtime.turn(TURN, call([user("permission please")]))).stream)
      expect(textOf(parts)).toBe("DENIED")
    })
  })

  test("keeps one agent session per host session and sends only the new prompt", () =>
    withRuntime({}, async (runtime) => {
      await collect((await runtime.turn(TURN, call([user("hello")]))).stream)
      const parts = await collect(
        (await runtime.turn(TURN, call([user("hello"), assistant("Hello from the fake agent"), user("echo")]))).stream,
      )
      expect(textOf(parts)).toBe("SESSION=acp_1 TURNS=2 PROMPT=echo")
    }))

  test("runs a one-shot request in a throwaway session with the whole transcript", () =>
    withRuntime({}, async (runtime) => {
      await collect((await runtime.turn(TURN, call([user("hello")]))).stream)
      const parts = await collect(
        (await runtime.turn({ ...TURN, kind: "title", agent: "title" }, call([user("echo name this session")]))).stream,
      )
      // A fresh agent process: its first session and first prompt, carrying the flattened transcript.
      expect(textOf(parts)).toBe("SESSION=acp_1 TURNS=1 PROMPT=user: echo name this session")
      // The live session's process never saw the one-shot prompt.
      const next = await collect((await runtime.turn(TURN, call([user("echo")]))).stream)
      expect(textOf(next)).toBe("SESSION=acp_1 TURNS=2 PROMPT=echo")
    }))

  test("cancels the agent's turn when the host aborts", () =>
    withRuntime({}, async (runtime) => {
      const controller = new AbortController()
      const { stream } = await runtime.turn(TURN, call([user("slow")], { abortSignal: controller.signal }))
      const reader = stream.getReader()
      const parts: LanguageModelV3StreamPart[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        if (value.type === "text-delta") controller.abort()
      }
      expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "other", raw: "cancelled" } })
    }))

  test("maps native_auto onto the agent's configured mode, and back", async () => {
    await withRuntime({ agent: { nativeApprovalMode: "trust" }, host: { mode: "native_auto" } }, async (runtime) => {
      expect(textOf(await collect((await runtime.turn(TURN, call([user("mode?")]))).stream))).toBe("MODE=trust")
    })
    await withRuntime({ agent: { nativeApprovalMode: "trust" }, host: { mode: "auto" } }, async (runtime) => {
      expect(textOf(await collect((await runtime.turn(TURN, call([user("mode?")]))).stream))).toBe("MODE=default")
    })
    // Without a configured native mode, native_auto never switches the agent's mode.
    await withRuntime({ host: { mode: "native_auto" } }, async (runtime) => {
      expect(textOf(await collect((await runtime.turn(TURN, call([user("mode?")]))).stream))).toBe("MODE=default")
    })
  })

  test("relaunches with the agent's approval flags at the next turn, and loads the conversation back", async () => {
    const selection: { mode: "normal" | "auto" | "native_auto" } = { mode: "normal" }
    await withRuntime({ agent: { nativeApprovalArgs: ["--trust-all-tools"] }, host: selection }, async (runtime) => {
      const ask = async (history: LanguageModelV3CallOptions["prompt"]) =>
        textOf(await collect((await runtime.turn(TURN, call([...history, user("trust?")]))).stream))
      expect(await ask([])).toBe("TRUSTED=false SESSION=acp_1 TURNS=1")
      // A new process (its first prompt) holding the same agent session; the replay is not forwarded.
      selection.mode = "native_auto"
      expect(await ask([user("trust?"), assistant("…")])).toBe("TRUSTED=true SESSION=acp_1 TURNS=1")
      selection.mode = "normal"
      expect(await ask([user("trust?"), assistant("…")])).toBe("TRUSTED=false SESSION=acp_1 TURNS=1")
    })
  })

  test("does not relaunch when the selection is switched away and back between turns", async () => {
    const selection: { mode: "normal" | "auto" | "native_auto" } = { mode: "normal" }
    await withRuntime({ agent: { nativeApprovalArgs: ["--trust-all-tools"] }, host: selection }, async (runtime) => {
      await collect((await runtime.turn(TURN, call([user("hello")]))).stream)
      selection.mode = "native_auto"
      selection.mode = "auto"
      const parts = await collect(
        (await runtime.turn(TURN, call([user("hello"), assistant("Hello from the fake agent"), user("trust?")])))
          .stream,
      )
      expect(textOf(parts)).toBe("TRUSTED=false SESSION=acp_1 TURNS=2")
    })
  })

  test("sends the whole transcript to a relaunched agent that cannot load sessions", async () => {
    const selection: { mode: "normal" | "auto" | "native_auto" } = { mode: "normal" }
    await withRuntime(
      { agent: { nativeApprovalArgs: ["--trust-all-tools"], env: { FAKE_ACP_NO_LOAD: "1" } }, host: selection },
      async (runtime) => {
        await collect((await runtime.turn(TURN, call([user("hello")]))).stream)
        selection.mode = "native_auto"
        const parts = await collect(
          (await runtime.turn(TURN, call([user("hello"), assistant("Hello from the fake agent"), user("echo")])))
            .stream,
        )
        expect(textOf(parts)).toBe(
          "SESSION=acp_1 TURNS=1 PROMPT=user: hello\n\nassistant: Hello from the fake agent\n\nuser: echo",
        )
      },
    )
  })

  test("runs one-shot requests without the approval flags", async () => {
    await withRuntime(
      { agent: { nativeApprovalArgs: ["--trust-all-tools"] }, host: { mode: "native_auto" } },
      async (runtime) => {
        const parts = await collect((await runtime.turn({ ...TURN, kind: "title" }, call([user("trust?")]))).stream)
        expect(textOf(parts)).toStartWith("TRUSTED=false")
      },
    )
  })

  const definition = (name: string) => ({
    name,
    description: `The ${name} tool`,
    inputSchema: { type: "object", properties: {} },
  })

  const binding = (names: readonly string[], direct: readonly string[] = []) => {
    const calls: Array<{ name: string; args: unknown; callID: string }> = []
    const tools: DelegatedToolBinding = {
      definitions: names.map(definition) as never,
      direct: new Set(direct),
      execute: async ({ name, args, callID }) => {
        calls.push({ name, args, callID })
        return { content: [{ type: "text", text: "1 todo" }], metadata: { todos: [{ content: "ship it" }] } }
      },
    }
    return { calls, tools }
  }

  const HOSTED: DelegatedTurn = { ...TURN, assistantMessageID: "msg_1" }

  test("serves the host's tools to the agent, filtered to what the host offers", async () => {
    const bound = binding(["todowrite", "bash", "mcp_docs", "mcp_hidden"], ["mcp_docs"])
    await withRuntime({ host: { tools: () => bound.tools } }, async (runtime) => {
      const parts = await collect((await runtime.turn(HOSTED, call([user("tools?")]))).stream)
      expect(textOf(parts)).toBe("TOOLS=todowrite,mcp_docs")
    })
  })

  test("runs a host tool under the agent's call id, without asking twice, and renders the host's result", async () => {
    const bound = binding(["todowrite"])
    await withRuntime({ host: { tools: () => bound.tools } }, async (runtime, checks) => {
      const parts = await collect((await runtime.turn(HOSTED, call([user("hostcall")]))).stream)
      expect(textOf(parts)).toBe("HOST TOOL DONE")
      // The host tool applies the host's policy itself; the agent's permission request is not a second prompt.
      expect(checks).toEqual([])
      expect(bound.calls).toEqual([
        { name: "todowrite", args: { todos: [{ content: "ship it", status: "pending" }] }, callID: "call_host" },
      ])
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
        toolCallId: "call_host",
        toolName: "todowrite",
        input: JSON.stringify({ todos: [{ content: "ship it", status: "pending" }] }),
      })
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
        toolCallId: "call_host",
        toolName: "todowrite",
        result: { output: "1 todo", metadata: { todos: [{ content: "ship it" }] } },
      })
    })
  })

  test("relaunches the agent when the host's tool catalog changes, keeping the conversation", async () => {
    let names = ["todowrite"]
    await withRuntime({ host: { tools: () => binding(names).tools } }, async (runtime) => {
      expect(textOf(await collect((await runtime.turn(HOSTED, call([user("tools?")]))).stream))).toBe("TOOLS=todowrite")
      names = ["todowrite", "skill"]
      const parts = await collect(
        (await runtime.turn(HOSTED, call([user("tools?"), assistant("…"), user("tools? echo")]))).stream,
      )
      expect(textOf(parts)).toBe("TOOLS=todowrite,skill")
      const next = await collect(
        (await runtime.turn(HOSTED, call([user("tools?"), assistant("…"), user("echo")]))).stream,
      )
      // Loaded back into a new process (its first prompt was the catalog check), same agent session.
      expect(textOf(next)).toBe("SESSION=acp_1 TURNS=2 PROMPT=echo")
    })
  })

  test("offers no host tools to an agent without HTTP MCP support", async () => {
    await withRuntime(
      { agent: { env: { FAKE_ACP_NO_HTTP: "1" } }, host: { tools: () => binding(["todowrite"]).tools } },
      async (runtime) => {
        expect(textOf(await collect((await runtime.turn(HOSTED, call([user("tools?")]))).stream))).toBe("TOOLS=none")
      },
    )
  })

  test("rejects host tool requests without the session's token", async () => {
    const endpoint = new AcpHostTools.Endpoint()
    const slot = new AcpHostTools.Slot("[]", [])
    endpoint.attach(slot)
    try {
      const entry = await endpoint.entry(slot)
      const post = (headers: Record<string, string>) =>
        fetch(entry.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        })
      expect((await post({})).status).toBe(401)
      expect((await post({ authorization: "Bearer wrong" })).status).toBe(401)
      expect((await post({ authorization: `Bearer ${slot.token}` })).status).toBe(200)
    } finally {
      endpoint.stop()
    }
  })

  test("reports an agent that dies mid-turn as its own error, and starts fresh next turn", () =>
    withRuntime({}, async (runtime) => {
      const parts = await collect((await runtime.turn(TURN, call([user("crash")]))).stream)
      const error = parts.find((part) => part.type === "error") as { error: Error } | undefined
      expect(error?.error.message).toStartWith("Fake ACP exited during the turn")
      expect((error?.error as { code?: unknown }).code).toBeUndefined()
      const next = await collect((await runtime.turn(TURN, call([user("echo")]))).stream)
      expect(textOf(next)).toBe("SESSION=acp_1 TURNS=1 PROMPT=echo")
    }))

  test("fails clearly when the agent cannot start", async () => {
    const runtime = new AcpRuntime.Runtime(agent({ command: "/nonexistent/acp-agent", args: [] }), host().host)
    await expect(runtime.turn(TURN, call([user("hello")]))).rejects.toThrow("Fake ACP did not start an ACP session")
  })
})
