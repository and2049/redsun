// REDSUN: `.redsun/memory.md` as durable project memory.
//
// Upstream discovers AGENTS.md walking up from the session directory. Redsun
// additionally loads `.redsun/memory.md` from the project root, so a project's
// accumulated architecture, workflow, and constraint notes reach every session
// without the user wiring an instructions entry.
//
// Gated on the same `project` policy as upstream's project instructions, so
// disabling project instructions disables project memory too.
export * as RedsunProjectMemory from "./project-memory.js"

import path from "node:path"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"

export const RELATIVE_PATH = path.join(".redsun", "memory.md")

export const Plugin = define({
  id: "redsun.instruction.project-memory",
  effect: Effect.fn(function* () {
    const discovery = yield* InstructionDiscovery.Service
    if (!discovery.project) return

    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const file = path.join(location.project.directory, RELATIVE_PATH)

    // An absent file simply contributes nothing, and an unreadable one warns
    // rather than failing session startup.
    const content = yield* fs
      .readFileStringSafe(file)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project memory unreadable", { file, cause }).pipe(Effect.as(undefined)),
        ),
      )
    if (content === undefined) return

    yield* discovery.transform((draft) => {
      draft.add({ path: AbsolutePath.make(file), content })
    })
  }),
})
