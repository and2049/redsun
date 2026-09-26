import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type { Usage } from "@opencode/plugin/usage"
import { Schema } from "effect"
import { AcpRuntime } from "./runtime.js"
import { AcpKiro } from "./kiro.js"
import type { AcpOptions } from "./options.js"

const Result = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({
    planName: Schema.optional(Schema.String),
    billingCycleReset: Schema.optional(Schema.String),
    usageBreakdowns: Schema.Array(
      Schema.Struct({
        resourceType: Schema.String,
        displayName: Schema.String,
        used: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        limit: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        hasLimit: Schema.Boolean,
      }),
    ),
  }),
})

export function parseKiroUsage(value: unknown): Usage.Data {
  const { data } = Schema.decodeUnknownSync(Result)(value)
  const windows = data.usageBreakdowns.flatMap((item, index): Usage.Window[] => {
    if (!item.hasLimit || item.limit <= 0) return []
    return [
      {
        id: `${item.resourceType}-${index}`,
        label: data.usageBreakdowns.length === 1 ? "Monthly" : `Monthly ${item.displayName}`,
        usedPercent: (item.used / item.limit) * 100,
        reset: data.billingCycleReset,
        detail: `${item.used.toLocaleString("en-US")} / ${item.limit.toLocaleString("en-US")} ${item.displayName.toLowerCase()}`,
      },
    ]
  })
  return {
    windows,
    plan: data.planName,
    ...(windows.length ? {} : { message: "This account did not report a monthly credit limit." }),
  }
}

/** Kiro extension, deliberately outside the generic ACP turn/usage_update handling. */
export async function readKiroUsage(
  agent: AcpOptions.Agent,
  cwd: string,
  signal: AbortSignal,
  spawn: AcpRuntime.Spawn = AcpRuntime.spawnProcess,
): Promise<Usage.Data> {
  signal.throwIfAborted()
  if (agent.home) AcpRuntime.prepareHome(agent.home)
  const process = spawn(agent, cwd, [])
  const connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    }),
    ndJsonStream(process.stdin, process.stdout),
  )
  let abort = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Usage request cancelled"))
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([
      cancelled,
      (async () => {
        const initialized = await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
        if (agent.preset === "kiro") {
          AcpKiro.validate(initialized)
          return parseKiroUsage(await connection.request("_kiro/account/getUsage", {}))
        }
        const session = await connection.newSession({ cwd, mcpServers: [] })
        return parseKiroUsage(
          await connection.request("_kiro.dev/commands/execute", {
            sessionId: session.sessionId,
            command: { command: "usage", args: {} },
          }),
        )
      })(),
    ])
  } finally {
    signal.removeEventListener("abort", abort)
    process.kill()
  }
}
