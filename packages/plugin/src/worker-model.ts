export * as WorkerModel from "./worker-model.js"

import { z } from "zod"
import { Rpc } from "./rpc.js"

// REDSUN: the model a session's worker subagents run on, as a "providerID/modelID[#variant]"
// reference. The server owns it; clients read, set and observe it through this RPC.

/**
 * `chosen` without `model` is an explicit "use the configured default"; a session that was never
 * chosen for takes the first client default offered with `ifUnset`. `revision` rises with every
 * write: a client keeps the highest it has seen, whichever of a read, reply or event brought it.
 */
export const Choice = z.object({ chosen: z.boolean(), model: z.string().optional(), revision: z.number().int() })
export type Choice = z.infer<typeof Choice>

export const Changed = Choice.extend({ sessionID: z.string() })
export type Changed = z.infer<typeof Changed>

export const rpc = Rpc.define({
  id: "redsun.worker-model",
  methods: {
    get: { input: z.object({ sessionID: z.string() }), output: Choice },
    /**
     * Omitting `model` chooses the configured default. With `ifUnset`, the write happens only if
     * the session has no choice yet, atomically on the server.
     */
    set: {
      input: z.object({ sessionID: z.string(), model: z.string().optional(), ifUnset: z.boolean().optional() }),
      output: Choice,
      errors: { invalid_model: z.object({ model: z.string() }) },
    },
  },
  events: { changed: { schema: Changed } },
})

export const CHANGED = `rpc.${rpc.id}.changed` as const
