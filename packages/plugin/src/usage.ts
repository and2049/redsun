export * as Usage from "./usage.js"

import { z } from "zod"
import { Rpc } from "./rpc.js"

// REDSUN: account quotas, independent of who owns the model's agent loop.
export const Window = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number().finite().nonnegative(),
  reset: z.string().optional(),
  detail: z.string().optional(),
})
export type Window = z.infer<typeof Window>

export const Snapshot = z.object({
  connected: z.boolean(),
  windows: z.array(Window),
  updatedAt: z.number(),
  plan: z.string().optional(),
  message: z.string().optional(),
})
export type Snapshot = z.infer<typeof Snapshot>
export type Data = Omit<Snapshot, "connected" | "updatedAt">

export const rpc = (providerID: string) =>
  Rpc.define({
    id: `redsun.usage.${providerID}`,
    methods: { read: { input: z.undefined(), output: Snapshot } },
    events: {},
  })

export const providers = [
  { id: "openai", label: "ChatGPT" },
  { id: "claude-code", label: "Claude" },
  { id: "kiro", label: "Kiro" },
] as const
