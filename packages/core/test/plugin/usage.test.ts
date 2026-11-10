import { expect } from "bun:test"
import { Effect } from "effect"
import { Usage } from "@opencode/plugin/usage"
import { registerUsage } from "@opencode/plugin/effect/usage"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Rpc } from "@opencode/core/rpc"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.effect("external Claude login enables usage without an OAuth token and rejects other methods", () =>
  Effect.gen(function* () {
    const ctx = yield* PluginHost.make(yield* Plugin.Service, "test")
    const credentials = yield* Credential.Service
    const rpc = (yield* Rpc.Service).client(Usage.rpc("claude-agent"))
    let reads = 0
    yield* registerUsage(ctx, {
      providerID: "claude-agent",
      type: "external",
      methods: ["claude-login"],
      read: async () => {
        reads++
        return { windows: [{ id: "weekly", label: "Weekly", usedPercent: 42 }] }
      },
    })
    expect((yield* rpc.read()).connected).toBe(false)
    yield* credentials.create({
      integrationID: Integration.ID.make("claude-agent"),
      value: Credential.External.make({ type: "external", methodID: Integration.MethodID.make("claude-login") }),
    })
    expect((yield* rpc.read()).windows[0]?.usedPercent).toBe(42)
    expect((yield* rpc.read()).connected).toBe(true)
    expect(reads).toBe(1)
    yield* credentials.create({
      integrationID: Integration.ID.make("claude-agent"),
      value: Credential.External.make({ type: "external", methodID: Integration.MethodID.make("other") }),
    })
    expect((yield* rpc.read()).connected).toBe(false)
    expect(reads).toBe(1)
  }),
)

it.effect("usage RPC gates credentials, deduplicates reads and invalidates cache on account switches", () =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const ctx = yield* PluginHost.make(plugin, "test")
    const credentials = yield* Credential.Service
    const rpc = (yield* Rpc.Service).client(Usage.rpc("openai"))
    let reads = 0
    yield* registerUsage(ctx, {
      providerID: "openai",
      methods: ["chatgpt-browser"],
      read: async (credential) => {
        reads++
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { windows: [{ id: "weekly", label: "Weekly", usedPercent: Number(credential.metadata?.used) }] }
      },
    })
    expect((yield* rpc.read()).connected).toBe(false)
    const key = yield* credentials.create({
      integrationID: Integration.ID.make("openai"),
      value: Credential.Key.make({ type: "key", key: "api-key" }),
    })
    expect((yield* rpc.read()).connected).toBe(false)
    const first = yield* credentials.create({
      integrationID: Integration.ID.make("openai"),
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("chatgpt-browser"),
        access: "one",
        refresh: "one",
        expires: Date.now() + 60_000,
        metadata: { used: 21 },
      }),
    })
    const snapshots = yield* Effect.all([rpc.read(), rpc.read()], { concurrency: "unbounded" })
    expect(snapshots.map((item) => item.windows[0]?.usedPercent)).toEqual([21, 21])
    expect(reads).toBe(1)
    yield* credentials.create({
      integrationID: Integration.ID.make("openai"),
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("chatgpt-browser"),
        access: "two",
        refresh: "two",
        expires: Date.now() + 60_000,
        metadata: { used: 65 },
      }),
    })
    expect((yield* rpc.read()).windows[0]?.usedPercent).toBe(65)
    expect(reads).toBe(2)
    yield* credentials.activate(key.id)
    expect((yield* rpc.read()).connected).toBe(false)
    yield* credentials.activate(first.id)
    expect((yield* rpc.read()).windows[0]?.usedPercent).toBe(21)
    expect(reads).toBe(3)
  }),
)
