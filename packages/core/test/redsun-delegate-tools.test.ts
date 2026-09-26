import { describe, expect, test } from "bun:test"
import { DelegateTools } from "@opencode/plugin/effect/delegate-tools"
import { DelegateHost } from "@opencode/core/delegate-host"
import { Permission } from "@opencode/core/permission"
import { Effect } from "effect"

// REDSUN: the shared host-tool selector both delegated runtimes use for their view of a binding.

const definition = (name: string) => ({
  type: "tool" as const,
  name,
  description: name,
  inputSchema: { type: "object" },
})
const names = [
  "read",
  "edit",
  "shell",
  "subagent",
  "skill",
  "todowrite",
  "worker_model",
  "execute",
  "acme_ping",
  "question",
]
const binding = (codeMode: boolean) => ({
  definitions: names.map(definition),
  direct: new Set(["acme_ping"]),
  ...(codeMode ? { codeMode: { summary: {}, render: () => "", update: () => "" } } : {}),
})

describe("DelegateTools.select", () => {
  test("extras: the host's own extras, direct MCP tools, and Code Mode only with its catalog", () => {
    expect(DelegateTools.select(binding(true), { mode: "extras" }).map((item) => item.name)).toEqual([
      "subagent",
      "skill",
      "todowrite",
      "worker_model",
      "execute",
      "acme_ping",
    ])
    expect(DelegateTools.select(binding(false), { mode: "extras" }).map((item) => item.name)).not.toContain("execute")
  })

  test("all: everything a native agent has, still without Code Mode when its catalog is missing", () => {
    const all = DelegateTools.select(binding(false), { mode: "all" }).map((item) => item.name)
    expect(all).toEqual(names.filter((name) => name !== "execute"))
    expect(DelegateTools.select(binding(true), { mode: "all" }).map((item) => item.name)).toEqual(names)
  })

  test("the request-level allowlist always intersects, in either mode", () => {
    expect(
      DelegateTools.select(binding(true), { mode: "all", available: ["edit", "execute", "missing"] }).map(
        (i) => i.name,
      ),
    ).toEqual(["edit", "execute"])
    expect(DelegateTools.select(binding(true), { mode: "extras", available: [] })).toEqual([])
    expect(
      DelegateTools.select(binding(true), { mode: "extras", available: ["read", "skill"] }).map((i) => i.name),
    ).toEqual(["skill"])
  })
})

describe("DelegateHost.bindSnapshot", () => {
  const bound = (failure: unknown) =>
    DelegateHost.bindSnapshot({ definitions: [], execute: () => Effect.die(failure) } as never, {
      sessionID: "ses_1" as never,
      agent: "build" as never,
      messageID: "msg_1" as never,
      direct: new Set(),
    }).execute({ name: "edit", args: {}, callID: "call_1", signal: new AbortController().signal })

  test("rejects a plain decline with the declined text a runtime relays to its agent", async () => {
    await expect(bound(new Permission.DeclinedError())).rejects.toThrow("The user declined this tool call")
  })

  test("leaves other defects as they are", async () => {
    await expect(bound(new Error("boom"))).rejects.toThrow("boom")
  })
})
