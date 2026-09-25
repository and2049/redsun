import { expect, test } from "bun:test"
import { parseKiroUsage, readKiroUsage } from "../src/usage.js"
import { AcpOptions } from "../src/options.js"
import type { AcpRuntime } from "../src/runtime.js"

const payload = {
  success: true,
  data: {
    planName: "KIRO STUDENT",
    billingCycleReset: "2026-10-01",
    usageBreakdowns: [{ resourceType: "CREDIT", displayName: "Credits", used: 7.69, limit: 1000, hasLimit: true }],
  },
}

test("monthly credits produce percentages, reset dates and credit amounts", () => {
  expect(parseKiroUsage(payload)).toEqual({
    plan: "KIRO STUDENT",
    windows: [
      { id: "CREDIT-0", label: "Monthly", usedPercent: 0.769, reset: "2026-10-01", detail: "7.69 / 1,000 credits" },
    ],
  })
  expect(
    parseKiroUsage({ ...payload, data: { usageBreakdowns: [{ ...payload.data.usageBreakdowns[0], limit: 0 }] } })
      .windows,
  ).toEqual([])
  expect(() => parseKiroUsage({ success: false })).toThrow()
})

test("usage uses only Kiro's ACP command, with no model prompt, and releases its process", async () => {
  const methods: string[] = []
  let killed = false
  const encoder = new TextEncoder()
  let output: ReadableStreamDefaultController<Uint8Array>
  const spawn: AcpRuntime.Spawn = () => ({
    stdout: new ReadableStream({
      start(controller) {
        output = controller
      },
    }),
    stdin: new WritableStream({
      write(chunk) {
        const request = JSON.parse(new TextDecoder().decode(chunk))
        methods.push(request.method)
        const result =
          request.method === "initialize"
            ? { protocolVersion: 1, agentCapabilities: {} }
            : request.method === "session/new"
              ? { sessionId: "usage-only" }
              : payload
        if (request.method === "_kiro.dev/commands/execute")
          expect(request.params).toEqual({
            sessionId: "usage-only",
            command: { command: "usage", args: {} },
          })
        output.enqueue(encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"))
      },
    }),
    kill: () => {
      killed = true
      output.close()
    },
    exited: new Promise(() => {}),
  })
  const { agents } = AcpOptions.parse({ agents: { kiro: { command: "kiro-cli", args: ["acp"] } } })
  const result = await readKiroUsage(agents[0]!, "/project", new AbortController().signal, spawn)
  expect(methods).toEqual(["initialize", "session/new", "_kiro.dev/commands/execute"])
  expect(result.windows).toHaveLength(1)
  expect(killed).toBe(true)
})

test("cancelling a stalled ACP initialization releases the usage process", async () => {
  const controller = new AbortController()
  let killed = false
  let output: ReadableStreamDefaultController<Uint8Array>
  const spawn: AcpRuntime.Spawn = () => ({
    stdout: new ReadableStream({
      start(value) {
        output = value
      },
    }),
    stdin: new WritableStream({
      write() {
        controller.abort()
      },
    }),
    kill: () => {
      killed = true
      output.close()
    },
    exited: new Promise(() => {}),
  })
  const { agents } = AcpOptions.parse({ agents: { kiro: { command: "kiro-cli", args: ["acp"] } } })
  await expect(readKiroUsage(agents[0]!, "/project", controller.signal, spawn)).rejects.toThrow("cancelled")
  expect(killed).toBe(true)
})
