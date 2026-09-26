import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import type {
  DelegatedApproval,
  DelegatedPermissionCheck,
  DelegatedSystemPrompt,
  DelegatedToolBinding,
  DelegatedTurn,
} from "@opencode/plugin/effect/delegate"
import { AcpContext } from "../src/context.js"
import { AcpHostTools } from "../src/host-tools.js"
import { AcpKiro } from "../src/kiro.js"
import type { AcpOptions } from "../src/options.js"
import { AcpRuntime } from "../src/runtime.js"

const agent = (extra: Partial<AcpOptions.Agent> = {}): AcpOptions.Agent => ({
  id: "fake",
  name: "Fake ACP",
  command: process.execPath,
  args: [path.join(import.meta.dir, "fixture/agent.ts")],
  env: {},
  models: [{ id: "default", name: "Fake ACP" }],
  inheritedInstructions: [],
  hostTools: "extras",
  prompt: "none",
  integration: { name: "Fake ACP", url: "" },
  ...extra,
})

const host = (
  input: {
    mode?: "normal" | "auto" | "native_auto"
    approve?: boolean
    feedback?: string
    tools?: () => DelegatedToolBinding | undefined
    cursors?: Map<string, string>
    reported?: string[][]
    context?: (turn: DelegatedTurn) => Awaited<ReturnType<NonNullable<AcpRuntime.Host["context"]>>>
    skillsAsked?: boolean[]
    system?: (turn: DelegatedTurn, tools: readonly string[]) => DelegatedSystemPrompt | undefined
  } = {},
) => {
  const checks: DelegatedPermissionCheck[] = []
  return {
    checks,
    host: {
      cwd: import.meta.dir,
      mode: async () => input.mode ?? "normal",
      approve: async (check: DelegatedPermissionCheck): Promise<DelegatedApproval> => {
        checks.push(check)
        if (input.approve ?? true) return { ok: true }
        return input.feedback ? { ok: false, feedback: input.feedback } : { ok: false }
      },
      tools: async () => input.tools?.(),
      ...(input.system
        ? { system: async (turn: DelegatedTurn, tools: readonly string[]) => input.system!(turn, tools) }
        : {}),
      onModels: (models) => void input.reported?.push(models.map((model) => model.id)),
      ...(input.context
        ? {
            context: async (turn: DelegatedTurn, request: { readonly skills: boolean }) => {
              input.skillsAsked?.push(request.skills)
              return input.context!(turn)
            },
          }
        : {}),
      ...(input.cursors
        ? {
            cursor: {
              get: async (sessionID: string) => input.cursors!.get(sessionID),
              set: async (sessionID: string, acpSessionID: string) => void input.cursors!.set(sessionID, acpSessionID),
            },
          }
        : {}),
    } satisfies AcpRuntime.Host,
  }
}

const TURN: DelegatedTurn = { sessionID: "ses_1", agent: "build", kind: "primary", modelID: "default" }

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }] })

const call = (prompt: LanguageModelV3CallOptions["prompt"], extra: Partial<LanguageModelV3CallOptions> = {}) =>
  ({
    prompt,
    // The final request catalog, which production core supplies independently of the host binding.
    tools: [
      "read",
      "shell",
      "bash",
      "skill",
      "todowrite",
      "subagent",
      "question",
      "execute",
      "mcp_docs",
      "mcp_hidden",
    ].map((name) => ({ type: "function", name, inputSchema: { type: "object" } })),
    ...extra,
  }) as LanguageModelV3CallOptions

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
  input: { agent?: Partial<AcpOptions.Agent>; host?: Parameters<typeof host>[0]; options?: AcpRuntime.Options },
  body: (runtime: AcpRuntime.Runtime, checks: DelegatedPermissionCheck[]) => Promise<void>,
) => {
  const made = host(input.host)
  const runtime = new AcpRuntime.Runtime(agent(input.agent), made.host, input.options)
  try {
    await body(runtime, made.checks)
  } finally {
    runtime.stop()
  }
}

describe("ACP runtime against a scripted agent", () => {
  test("waits for extension compaction completion before releasing the turn", async () => {
    await withRuntime(
      {
        agent: { compactCommand: "/compact", env: { FAKE_ACP_ASYNC_COMPACT: "complete" } },
        options: { compactionStatus: AcpKiro.compactionStatus },
      },
      async (runtime) => {
        const compact = await runtime.turn(TURN, call([user("/compact")]))
        const reader = compact.stream.getReader()
        await reader.read()
        await expect(runtime.turn(TURN, call([user("hello")]))).rejects.toThrow()
        const parts: LanguageModelV3StreamPart[] = []
        for (;;) {
          const item = await reader.read()
          if (item.done) break
          parts.push(item.value)
        }
        expect(textOf(parts)).toContain("compacted its native session history")
        const next = await collect((await runtime.turn(TURN, call([user("hello")]))).stream)
        expect(textOf(next)).toBe("Hello from the fake agent")
      },
    )
  })

  for (const mode of ["fail", "hang"])
    test(`surfaces asynchronous compaction ${mode} and recovers on the next turn`, async () => {
      await withRuntime(
        {
          agent: { compactCommand: "/compact", env: { FAKE_ACP_ASYNC_COMPACT: mode } },
          options: { compactionStatus: AcpKiro.compactionStatus, compactionTimeoutMs: 150 },
        },
        async (runtime) => {
          const parts = await collect((await runtime.turn(TURN, call([user("/compact")]))).stream)
          const error = parts.find((part) => part.type === "error")
          expect(textOf(parts)).not.toContain("compacted its native session history")
          expect(String(error?.error)).toContain(mode === "fail" ? "fixture compaction failed" : "Timed out")
          expect(textOf(await collect((await runtime.turn(TURN, call([user("hello")]))).stream))).toBe(
            "Hello from the fake agent",
          )
        },
      )
    })

  test("interrupts an acknowledged asynchronous compaction and replaces the process", async () => {
    await withRuntime(
      {
        agent: { compactCommand: "/compact", env: { FAKE_ACP_ASYNC_COMPACT: "hang" } },
        options: { compactionStatus: AcpKiro.compactionStatus },
      },
      async (runtime) => {
        const controller = new AbortController()
        const reader = (
          await runtime.turn(TURN, call([user("/compact")], { abortSignal: controller.signal }))
        ).stream.getReader()
        await reader.read()
        controller.abort()
        const parts: LanguageModelV3StreamPart[] = []
        for (;;) {
          const item = await reader.read()
          if (item.done) break
          parts.push(item.value)
        }
        expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "other", raw: "cancelled" } })
        expect(textOf(await collect((await runtime.turn(TURN, call([user("hello")]))).stream))).toBe(
          "Hello from the fake agent",
        )
      },
    )
  })

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

  test("hands the user's correction on a decline to the agent with its next prompt", async () => {
    await withRuntime({ host: { approve: false, feedback: "use the b file instead" } }, async (runtime) => {
      expect(textOf(await collect((await runtime.turn(TURN, call([user("permission please")]))).stream))).toBe("DENIED")
      const parts = await collect(
        (await runtime.turn(TURN, call([user("permission please"), assistant("DENIED"), user("echo")]))).stream,
      )
      expect(textOf(parts)).toBe(
        'SESSION=acp_1 TURNS=2 PROMPT=[redsun] The user declined "Edit src/a.ts" and said: use the b file instead\n\necho',
      )
      // Delivered once.
      const again = await collect(
        (await runtime.turn(TURN, call([user("permission please"), assistant("DENIED"), user("echo")]))).stream,
      )
      expect(textOf(again)).toBe("SESSION=acp_1 TURNS=3 PROMPT=echo")
    })
  })

  test("asks about a shell command by its command line, not the agent's title", async () => {
    await withRuntime({}, async (runtime, checks) => {
      expect(textOf(await collect((await runtime.turn(TURN, call([user("shell?")]))).stream))).toBe("RAN")
      expect(checks).toEqual([
        {
          sessionID: "ses_1",
          agent: "build",
          action: "shell",
          resources: ["rm -rf build"],
          metadata: { source: "acp", toolCallId: "call_shell", title: "Run command" },
        },
      ])
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

  test("ends a cancelled turn the agent will not stop by killing it, and starts fresh next turn", () =>
    withRuntime({ options: { interruptGraceMs: 100 }, host: { cursors: new Map() } }, async (runtime) => {
      const controller = new AbortController()
      const started = Date.now()
      const { stream } = await runtime.turn(TURN, call([user("stubborn")], { abortSignal: controller.signal }))
      const reader = stream.getReader()
      const parts: LanguageModelV3StreamPart[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        if (value.type === "text-delta") controller.abort()
      }
      expect(Date.now() - started).toBeLessThan(2_500)
      expect(parts.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: "other", raw: "cancelled" } })
      expect(parts.some((part) => part.type === "error")).toBe(false)
      // A new process loads the agent session back and gets only the new prompt.
      const next = await collect(
        (await runtime.turn(TURN, call([user("stubborn"), assistant("…"), user("echo")]))).stream,
      )
      expect(textOf(next)).toBe("SESSION=acp_1 TURNS=1 PROMPT=echo")
    }))

  test("refuses a second primary turn while one is in flight for the session", () =>
    withRuntime({}, async (runtime) => {
      const controller = new AbortController()
      const { stream } = await runtime.turn(TURN, call([user("slow")], { abortSignal: controller.signal }))
      const reader = stream.getReader()
      await reader.read()
      await expect(runtime.turn(TURN, call([user("hello")]))).rejects.toThrow("already processing a turn")
      controller.abort()
      for (;;) if ((await reader.read()).done) break
      // Released with the stream.
      expect(
        textOf(await collect((await runtime.turn(TURN, call([user("hello"), assistant("…"), user("echo")]))).stream)),
      ).toContain("PROMPT=echo")
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
    // Nor for an agent confined to host tools: its own mode would have nothing to judge.
    await withRuntime(
      { agent: { nativeApprovalMode: "trust", hostTools: "all" }, host: { mode: "native_auto" } },
      async (runtime) => {
        expect(textOf(await collect((await runtime.turn(TURN, call([user("mode?")]))).stream))).toBe("MODE=default")
      },
    )
  })

  test("maps the host's Auto-approve onto the agent's approve-everything mode or flags", async () => {
    await withRuntime({ agent: { autoApprovalMode: "trust" }, host: { mode: "auto" } }, async (runtime) => {
      expect(textOf(await collect((await runtime.turn(TURN, call([user("mode?")]))).stream))).toBe("MODE=trust")
    })
    const selection: { mode: "normal" | "auto" | "native_auto" } = { mode: "auto" }
    await withRuntime({ agent: { autoApprovalArgs: ["--trust-all-tools"] }, host: selection }, async (runtime) => {
      const ask = async (history: LanguageModelV3CallOptions["prompt"]) =>
        textOf(await collect((await runtime.turn(TURN, call([...history, user("trust?")]))).stream))
      expect(await ask([])).toBe("TRUSTED=true SESSION=acp_1 TURNS=1")
      selection.mode = "normal"
      expect(await ask([user("trust?"), assistant("…")])).toBe("TRUSTED=false SESSION=acp_1 TURNS=1")
      // Without a judgement-based mode of its own, native_auto is Manual for this agent.
      selection.mode = "native_auto"
      expect(await ask([user("trust?"), assistant("…")])).toBe("TRUSTED=false SESSION=acp_1 TURNS=2")
    })
  })

  test("answers an agent without an approve-everything mode of its own under Auto-approve, never relaunching it", async () => {
    const selection: { mode: "normal" | "auto" | "native_auto" } = { mode: "auto" }
    await withRuntime({ host: selection }, async (runtime, checks) => {
      const ask = async (history: LanguageModelV3CallOptions["prompt"], text: string) =>
        textOf(await collect((await runtime.turn(TURN, call([...history, user(text)]))).stream))
      // Launched standard, in its default mode; its ask reaches the host, which approves at once.
      expect(await ask([], "permission please")).toBe("ALLOWED")
      expect(checks).toMatchObject([{ action: "edit", resources: ["src/a.ts"] }])
      const history = [user("permission please"), assistant("ALLOWED")]
      expect(await ask(history, "mode?")).toBe("MODE=default")
      expect(await ask(history, "trust?")).toBe("TRUSTED=false SESSION=acp_1 TURNS=3")
      // Switching the selection between turns costs no relaunch either way.
      selection.mode = "normal"
      expect(await ask(history, "trust?")).toBe("TRUSTED=false SESSION=acp_1 TURNS=4")
      selection.mode = "auto"
      expect(await ask(history, "trust?")).toBe("TRUSTED=false SESSION=acp_1 TURNS=5")
    })
    // The decision stays the host's: a deny under Auto-approve (a rule, never touched by it) reaches the agent.
    await withRuntime({ host: { mode: "auto", approve: false } }, async (runtime) => {
      expect(textOf(await collect((await runtime.turn(TURN, call([user("permission please")]))).stream))).toBe("DENIED")
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

  test("matches a host tool call that reaches the host before the agent reports it", async () => {
    const bound = binding(["todowrite"])
    await withRuntime({ host: { tools: () => bound.tools } }, async (runtime) => {
      const parts = await collect((await runtime.turn(HOSTED, call([user("hostlate")]))).stream)
      expect(textOf(parts)).toBe("LATE DONE")
      expect(bound.calls.map((item) => item.callID)).toEqual(["call_late"])
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
        toolCallId: "call_late",
        result: { output: "1 todo", metadata: { todos: [{ content: "ship it" }] } },
      })
    })
  })

  test("renders a host tool call the agent never reported", async () => {
    const bound = binding(["todowrite"])
    await withRuntime({ host: { tools: () => bound.tools } }, async (runtime) => {
      const parts = await collect((await runtime.turn(HOSTED, call([user("hostquiet")]))).stream)
      expect(textOf(parts)).toBe("QUIET DONE")
      expect(bound.calls.map((item) => item.name)).toEqual(["todowrite"])
      const id = bound.calls[0]!.callID
      expect(id).toStartWith("acp-mcp-msg_1-")
      expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
        toolCallId: id,
        toolName: "todowrite",
        input: JSON.stringify({ todos: [] }),
        providerExecuted: true,
      })
      expect(parts.find((part) => part.type === "tool-result")).toMatchObject({
        toolCallId: id,
        result: { output: "1 todo", metadata: { todos: [{ content: "ship it" }] } },
      })
    })
  })

  test("serves every host tool to an agent confined to them", async () => {
    const bound = binding(["read", "shell", "todowrite", "execute"])
    await withRuntime({ agent: { hostTools: "all" }, host: { tools: () => bound.tools } }, async (runtime) => {
      const parts = await collect((await runtime.turn(HOSTED, call([user("tools?")]))).stream)
      // Code Mode still needs its catalog.
      expect(textOf(parts)).toBe("TOOLS=read,shell,todowrite")
    })
  })

  for (const mode of ["all", "extras"] as const)
    test(`intersects the final request catalog and tool choice under ${mode}`, async () => {
      const bound = binding(["todowrite", "skill"])
      await withRuntime({ agent: { hostTools: mode }, host: { tools: () => bound.tools } }, async (runtime) => {
        const filtered = { tools: [{ type: "function" as const, name: "skill", inputSchema: { type: "object" } }] }
        const ask = async (extra: Partial<LanguageModelV3CallOptions>, text = "tools?") =>
          collect((await runtime.turn(HOSTED, call([user(text)], extra))).stream)
        expect(textOf(await ask(filtered))).toBe("TOOLS=skill")
        // A removed tool is refused even when the agent calls the MCP endpoint directly.
        expect(textOf(await ask(filtered, "hostquiet"))).toBe("QUIET FAILED")
        await ask(filtered, "plan!")
        expect(bound.calls).toEqual([])
        expect(textOf(await ask({ toolChoice: { type: "none" } }))).toBe("TOOLS=none")
        await ask({ toolChoice: { type: "none" } }, "plan!")
        expect(bound.calls).toEqual([])
        expect(textOf(await ask({ tools: [] }))).toBe("TOOLS=none")
        expect(textOf(await ask({ tools: undefined }))).toBe("TOOLS=none")
      })
    })

  test("cancels an in-flight host call with the turn, and can execute another turn", async () => {
    const started = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    const bound = binding(["todowrite"])
    let count = 0
    const tools: DelegatedToolBinding = {
      ...bound.tools,
      execute: async ({ signal }) => {
        if (++count !== 1) return { content: [{ type: "text", text: "recovered" }] }
        started.resolve()
        return new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              stopped.resolve()
              reject(new Error("interrupted"))
            },
            { once: true },
          )
        })
      },
    }
    await withRuntime({ host: { tools: () => tools } }, async (runtime) => {
      const controller = new AbortController()
      const pending = collect(
        (await runtime.turn(HOSTED, call([user("hostcall")], { abortSignal: controller.signal }))).stream,
      )
      await started.promise
      controller.abort()
      await stopped.promise
      await pending
      const next = await collect(
        (await runtime.turn({ ...HOSTED, assistantMessageID: "msg_2" }, call([user("hostcall")]))).stream,
      )
      expect(next.find((part) => part.type === "tool-result")).toMatchObject({ result: "recovered" })
    })
  })

  test("starts the agent in the home the host manages for it", async () => {
    const dir = path.join(import.meta.dir, ".home-" + process.pid)
    try {
      await withRuntime(
        {
          agent: {
            home: { env: "FAKE_ACP_HOME", path: dir, files: { "agents/redsun.json": '{"tools":["@redsun"]}\n' } },
          },
        },
        async (runtime) => {
          const parts = await collect((await runtime.turn(TURN, call([user("home?")]))).stream)
          expect(textOf(parts)).toBe(`HOME=${dir} PROFILE={"tools":["@redsun"]}`)
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  test("resumes the agent session a host session last used after the host restarts", async () => {
    const cursors = new Map<string, string>()
    await withRuntime({ host: { cursors } }, async (runtime) => {
      await collect((await runtime.turn(TURN, call([user("hello")]))).stream)
    })
    expect(cursors.get("ses_1")).toBe("acp_1")
    // A new runtime (a restarted host): the agent loads its session and gets only the new prompt.
    await withRuntime({ host: { cursors } }, async (runtime) => {
      const parts = await collect(
        (await runtime.turn(TURN, call([user("hello"), assistant("Hello from the fake agent"), user("echo")]))).stream,
      )
      expect(textOf(parts)).toBe("SESSION=acp_1 TURNS=1 PROMPT=echo")
    })
  })

  test("sends the whole transcript when the agent joins a conversation it has not seen", async () => {
    // No stored session (e.g. the user switched to this agent mid-conversation).
    await withRuntime({ host: { cursors: new Map() } }, async (runtime) => {
      const parts = await collect(
        (await runtime.turn(TURN, call([user("hello"), assistant("Hi from another model"), user("echo")]))).stream,
      )
      expect(textOf(parts)).toBe(
        "SESSION=acp_1 TURNS=1 PROMPT=user: hello\n\nassistant: Hi from another model\n\nuser: echo",
      )
    })
    // A stored session the agent cannot load gets the transcript too.
    const cursors = new Map([["ses_1", "acp_9"]])
    await withRuntime({ agent: { env: { FAKE_ACP_NO_LOAD: "1" } }, host: { cursors } }, async (runtime) => {
      const parts = await collect(
        (await runtime.turn(TURN, call([user("hello"), assistant("Hello"), user("echo")]))).stream,
      )
      expect(textOf(parts)).toStartWith("SESSION=acp_1 TURNS=1 PROMPT=user: hello")
    })
    expect(cursors.get("ses_1")).toBe("acp_1")
  })

  for (const style of ["config", "legacy"] as const)
    test(`reports the agent's models and switches to the selected one (${style})`, async () => {
      const reported: string[][] = []
      await withRuntime({ agent: { env: { FAKE_ACP_MODELS: style } }, host: { reported } }, async (runtime) => {
        const ask = async (modelID: string) =>
          textOf(await collect((await runtime.turn({ ...TURN, modelID }, call([user("model?")]))).stream))
        expect(await ask("fast")).toBe("MODEL=fast")
        expect(reported).toEqual([["auto", "fast"]])
        // `default` is the model the agent started the session with.
        expect(await ask("default")).toBe("MODEL=auto")
      })
    })

  test("leaves the model alone when the agent reports no selector", () =>
    withRuntime({}, async (runtime) => {
      const parts = await collect((await runtime.turn({ ...TURN, modelID: "fast" }, call([user("model?")]))).stream)
      expect(textOf(parts)).toBe("MODEL=auto")
    }))

  test("discovers the agent's models with a throwaway session", async () => {
    const reported: string[][] = []
    await withRuntime({ agent: { env: { FAKE_ACP_MODELS: "legacy" } }, host: { reported } }, async (runtime) => {
      await runtime.discover()
      expect(reported).toEqual([["auto", "fast"]])
    })
  })

  test("records the agent's plan as the host's todo list through the host's todowrite", async () => {
    const bound = binding(["todowrite"])
    await withRuntime({ host: { tools: () => bound.tools } }, async (runtime) => {
      const parts = await collect((await runtime.turn(HOSTED, call([user("plan!")]))).stream)
      expect(textOf(parts)).toBe("PLANNED")
      expect(bound.calls.map((item) => item.args)).toEqual([
        {
          todos: [
            { content: "write tests", status: "in_progress", priority: "high" },
            { content: "ship", status: "pending", priority: "low" },
          ],
        },
        {
          todos: [
            { content: "write tests", status: "completed", priority: "high" },
            { content: "ship", status: "pending", priority: "low" },
          ],
        },
      ])
      expect(bound.calls.map((item) => item.callID)).toEqual(["acp-plan-msg_1-1", "acp-plan-msg_1-2"])
      const results = parts.filter((part) => part.type === "tool-result")
      expect(results).toHaveLength(2)
      expect(results[0]).toMatchObject({ toolName: "todowrite", result: { output: "1 todo" } })
      // Every recorded plan settles before the turn finishes.
      expect(parts.at(-1)).toMatchObject({ type: "finish" })
    })
  })

  test("leaves the todo list alone when the turn may not use todowrite", async () => {
    const bound = binding(["skill"])
    await withRuntime({ host: { tools: () => bound.tools } }, async (runtime) => {
      const parts = await collect((await runtime.turn(HOSTED, call([user("plan!")]))).stream)
      expect(bound.calls).toEqual([])
      expect(parts.some((part) => part.type === "tool-call")).toBe(false)
    })
  })

  describe("host context", () => {
    const agentsFile = path.join(import.meta.dir, "AGENTS.md")
    let rules = "Use tabs."
    const context = () => ({
      agent: { id: "build", system: "Be brief." },
      isWorker: false,
      files: [
        { path: agentsFile, content: "Kiro reads this itself." },
        { path: "/etc/redsun/rules.md", content: rules },
      ],
      skills: [{ id: "deploy", name: "deploy", description: "Ship it" }],
    })
    const promptOf = (parts: readonly LanguageModelV3StreamPart[]) => textOf(parts).split("PROMPT=")[1] ?? ""

    test("goes ahead of the first prompt once, then only what changed", async () => {
      rules = "Use tabs."
      const asked: boolean[] = []
      await withRuntime(
        {
          agent: { inheritedInstructions: ["AGENTS.md"] },
          host: { context, skillsAsked: asked, tools: () => binding(["skill"]).tools },
        },
        async (runtime) => {
          const first = promptOf(await collect((await runtime.turn(HOSTED, call([user("echo one")]))).stream))
          expect(first).toStartWith("<redsun-context>\nContext from redsun")
          expect(first).toContain("[redsun agent instructions: build]\nBe brief.")
          expect(first).toContain("Instructions from: /etc/redsun/rules.md\nUse tabs.")
          expect(first).not.toContain("Kiro reads this itself.")
          expect(first).toContain('the `skill` tool of the "redsun" MCP server')
          expect(first).toContain('"id":"deploy"')
          expect(first).toEndWith("</redsun-context>\n\necho one")
          expect(asked).toEqual([true])

          const second = promptOf(
            await collect(
              (await runtime.turn(HOSTED, call([user("echo one"), assistant("ok"), user("echo two")]))).stream,
            ),
          )
          expect(second).toBe("echo two")

          rules = "Use spaces."
          const third = promptOf(
            await collect(
              (await runtime.turn(HOSTED, call([user("echo one"), assistant("ok"), user("echo three")]))).stream,
            ),
          )
          expect(third).toContain("Instructions from: /etc/redsun/rules.md\nUse spaces.")
          expect(third).not.toContain("Be brief.")
          expect(third).not.toContain("deploy")
        },
      )
    })

    test("sends the new agent's instructions once on an agent change, in the same agent session", async () => {
      rules = "Use tabs."
      const perAgent = (turn: DelegatedTurn) => ({
        ...context(),
        agent: { id: turn.agent, system: `Act as ${turn.agent}.` },
      })
      await withRuntime({ host: { context: perAgent } }, async (runtime) => {
        const history = [user("echo one"), assistant("ok")]
        const first = textOf(await collect((await runtime.turn(HOSTED, call([user("echo one")]))).stream))
        expect(first).toContain("[redsun agent instructions: build]\nAct as build.")
        const switched = textOf(
          await collect(
            (await runtime.turn({ ...HOSTED, agent: "plan" }, call([...history, user("echo two")]))).stream,
          ),
        )
        expect(switched).toStartWith("SESSION=acp_1 TURNS=2")
        expect(switched).toContain("[redsun agent instructions: plan]\nAct as plan.")
        expect(switched).not.toContain("Use tabs.")
        const again = promptOf(
          await collect(
            (await runtime.turn({ ...HOSTED, agent: "plan" }, call([...history, user("echo three")]))).stream,
          ),
        )
        expect(again).toBe("echo three")
      })
    })

    test("fails the turn before prompting when the host context is unavailable, then delivers it on retry", async () => {
      rules = "Use tabs."
      let available = false
      const flaky = () => {
        if (!available) throw new Error("instructions could not be read")
        return context()
      }
      await withRuntime({ host: { context: flaky } }, async (runtime) => {
        await expect(runtime.turn(HOSTED, call([user("echo one")]))).rejects.toThrow("instructions could not be read")
        available = true
        const sent = textOf(await collect((await runtime.turn(HOSTED, call([user("echo one")]))).stream))
        // The failed turn never reached the agent.
        expect(sent).toStartWith("SESSION=acp_1 TURNS=1")
        expect(sent).toContain("[redsun agent instructions: build]\nBe brief.")
      })
    })

    test("sends a compaction command alone, then everything again", async () => {
      rules = "Use tabs."
      await withRuntime({ agent: { compactCommand: "/compact echo" }, host: { context } }, async (runtime) => {
        await collect((await runtime.turn(HOSTED, call([user("echo one")]))).stream)
        const compact = promptOf(
          await collect(
            (await runtime.turn(HOSTED, call([user("echo one"), assistant("ok"), user("/compact echo")]))).stream,
          ),
        )
        expect(compact).toBe("/compact echo")
        const after = promptOf(
          await collect((await runtime.turn(HOSTED, call([user("echo one"), assistant("ok"), user("echo")]))).stream),
        )
        expect(after).toContain("Instructions from: /etc/redsun/rules.md")
        expect(after).toContain("Be brief.")
      })
    })

    describe("base prompt", () => {
      const system = (asked: (readonly string[])[]) => (turn: DelegatedTurn, tools: readonly string[]) => {
        asked.push(tools)
        return { static: [`BASE for ${turn.agent}`, "TOOL GUIDANCE"], dynamic: ["ENV today"] }
      }

      test("fails before prompting if the base is unavailable, then retries without losing the agent prompt", async () => {
        let available = false
        await withRuntime(
          {
            agent: { prompt: "prefix" },
            host: {
              context,
              system: () => (available ? { static: ["Be brief."], dynamic: ["ENV"] } : undefined),
            },
          },
          async (runtime) => {
            await expect(runtime.turn(HOSTED, call([user("echo")]))).rejects.toThrow("host base prompt is unavailable")
            available = true
            const sent = promptOf(await collect((await runtime.turn(HOSTED, call([user("echo")]))).stream))
            expect(sent).toContain("Be brief.")
            expect(sent.match(/Be brief\./g)).toHaveLength(1)
          },
        )
      })

      for (const key of ["FAKE_ACP_NO_LOAD", "FAKE_ACP_FAIL_LOAD"])
        test(`restores the base when a replacement has no history (${key})`, async () => {
          const env = { [key]: "1" }
          const asked: (readonly string[])[] = []
          let names = ["todowrite"]
          await withRuntime(
            {
              agent: { prompt: "prefix", env },
              host: { context, system: system(asked), tools: () => binding(names).tools },
            },
            async (runtime) => {
              await collect((await runtime.turn(HOSTED, call([user("echo")]))).stream)
              // A new process without history must receive context even if the host prompt has no assistant row.
              names = ["skill"]
              const sent = promptOf(await collect((await runtime.turn(HOSTED, call([user("echo")]))).stream))
              expect(sent).toContain("BASE for build")
              expect(sent).toContain("Use tabs.")
            },
          )
        })

      test("retries base delivery after a cancelled prompt", async () => {
        await withRuntime({ agent: { prompt: "prefix" }, host: { context, system: system([]) } }, async (runtime) => {
          const controller = new AbortController()
          const reader = (
            await runtime.turn(HOSTED, call([user("slow")], { abortSignal: controller.signal }))
          ).stream.getReader()
          while ((await reader.read()).value?.type !== "text-delta") {}
          controller.abort()
          while (!(await reader.read()).done) {}
          const sent = promptOf(await collect((await runtime.turn(HOSTED, call([user("echo")]))).stream))
          expect(sent).toContain("BASE for build")
        })
      })

      test("with prefix, goes ahead of the brief in the first prompt of each agent session", async () => {
        rules = "Use tabs."
        const asked: (readonly string[])[] = []
        await withRuntime(
          {
            agent: { prompt: "prefix", compactCommand: "/compact echo" },
            // A worker, so the brief has its standing line to follow the base prompt.
            host: {
              context: () => ({ ...context(), isWorker: true }),
              system: system(asked),
              tools: () => binding(["skill"]).tools,
            },
          },
          async (runtime) => {
            const first = promptOf(await collect((await runtime.turn(HOSTED, call([user("echo one")]))).stream))
            expect(first).toStartWith(
              [
                "<redsun-context>",
                "Context from redsun, the application hosting this session. It is not part of the user's message.",
                "",
                AcpContext.BASE,
                "BASE for build\n\nTOOL GUIDANCE\n\nENV today",
                "",
                "[redsun agent instructions: build]",
                "[redsun worker]",
              ].join("\n"),
            )
            // The agent's own prompt is in the base prompt; the brief does not repeat it.
            expect(first).not.toContain("Be brief.")
            expect(first).toContain("Instructions from: /etc/redsun/rules.md\nUse tabs.")
            expect(first).toEndWith("</redsun-context>\n\necho one")
            expect(asked).toEqual([["skill"]])

            const second = promptOf(
              await collect(
                (await runtime.turn(HOSTED, call([user("echo one"), assistant("ok"), user("echo two")]))).stream,
              ),
            )
            expect(second).toBe("echo two")

            // Another agent's base prompt differs, so it is sent again.
            const other = promptOf(
              await collect(
                (
                  await runtime.turn(
                    { ...HOSTED, agent: "plan" },
                    call([user("echo one"), assistant("ok"), user("echo three")]),
                  )
                ).stream,
              ),
            )
            expect(other).toContain("BASE for plan")

            await collect(
              (await runtime.turn(HOSTED, call([user("echo one"), assistant("ok"), user("/compact echo")]))).stream,
            )
            const after = promptOf(
              await collect(
                (await runtime.turn(HOSTED, call([user("echo one"), assistant("ok"), user("echo")]))).stream,
              ),
            )
            expect(after).toContain("BASE for build")
          },
        )
      })

      test("with none, is never sent and the brief keeps the agent's prompt", async () => {
        rules = "Use tabs."
        const asked: (readonly string[])[] = []
        await withRuntime({ host: { context, system: system(asked) } }, async (runtime) => {
          const first = promptOf(await collect((await runtime.turn(HOSTED, call([user("echo one")]))).stream))
          expect(first).not.toContain("BASE")
          expect(first).not.toContain(AcpContext.BASE)
          expect(first).toContain("[redsun agent instructions: build]\nBe brief.")
          const second = promptOf(
            await collect(
              (await runtime.turn(HOSTED, call([user("echo one"), assistant("ok"), user("echo two")]))).stream,
            ),
          )
          expect(second).toBe("echo two")
        })
        expect(asked).toEqual([])
      })
    })

    test("offers Code Mode with its catalog", async () => {
      const bound = binding(["todowrite", "execute"])
      const tools: DelegatedToolBinding = {
        ...bound.tools,
        codeMode: { summary: { tools: ["a"] }, render: () => "CODE MODE CATALOG", update: () => "CODE MODE UPDATE" },
      }
      await withRuntime({ host: { context, tools: () => tools } }, async (runtime) => {
        const parts = await collect((await runtime.turn(HOSTED, call([user("tools? echo")]))).stream)
        expect(textOf(parts)).toStartWith("TOOLS=todowrite,execute")
      })
      await withRuntime({ host: { context, tools: () => tools } }, async (runtime) => {
        const prompt = promptOf(await collect((await runtime.turn(HOSTED, call([user("echo")]))).stream))
        expect(prompt).toContain("CODE MODE CATALOG")
      })
      // Without a catalog, execute is not offered.
      await withRuntime({ host: { context, tools: () => bound.tools } }, async (runtime) => {
        const parts = await collect((await runtime.turn(HOSTED, call([user("tools?")]))).stream)
        expect(textOf(parts)).toBe("TOOLS=todowrite")
      })
    })
  })

  test("reports an agent that dies mid-turn as its own error, and starts fresh next turn", () =>
    withRuntime({}, async (runtime) => {
      const parts = await collect((await runtime.turn(TURN, call([user("crash")]))).stream)
      const error = parts.find((part) => part.type === "error") as { error: Error } | undefined
      expect(error?.error.message).toStartWith("Fake ACP exited during the turn")
      expect(error?.error.message).toEndWith("The agent said:\nfake agent: out of credits")
      expect((error?.error as { code?: unknown }).code).toBeUndefined()
      const next = await collect((await runtime.turn(TURN, call([user("echo")]))).stream)
      expect(textOf(next)).toBe("SESSION=acp_1 TURNS=1 PROMPT=echo")
    }))

  test("checks the agent's own sign-in for its integration", async () => {
    const whoami = {
      name: "Fake",
      url: "",
      whoami: [path.join(import.meta.dir, "fixture/agent.ts"), "whoami"],
      signIn: "Run `fake login`.",
    }
    await withRuntime({ agent: { integration: whoami } }, async (runtime) => {
      expect(await runtime.signedIn()).toEqual({ accountType: "BuilderId", email: "dev@example.com" })
    })
    await withRuntime({ agent: { integration: whoami, env: { FAKE_ACP_SIGNED_OUT: "1" } } }, async (runtime) => {
      await expect(runtime.signedIn()).rejects.toThrow("Fake ACP is not signed in. Run `fake login`.")
    })
    // Without a whoami command, a session that starts is the check.
    await withRuntime({}, async (runtime) => {
      expect(await runtime.signedIn()).toEqual({})
    })
  })

  test("fails clearly when the agent cannot start", async () => {
    const runtime = new AcpRuntime.Runtime(agent({ command: "/nonexistent/acp-agent", args: [] }), host().host)
    await expect(runtime.turn(TURN, call([user("hello")]))).rejects.toThrow("Fake ACP did not start an ACP session")
  })
})
