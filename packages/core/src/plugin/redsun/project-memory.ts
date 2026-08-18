// REDSUN: `.redsun/memory.md` as durable project memory.
//
// Upstream discovers AGENTS.md walking up from the session directory. Redsun
// additionally loads `.redsun/memory.md` from the project root, so a project's
// accumulated architecture, workflow, and constraint notes reach every session
// without the user wiring an instructions entry.
//
// Gated on the same `project` policy as upstream's project instructions, so
// disabling project instructions disables project memory too.
//
// Two halves, mirroring config/plugin/instruction.ts:
//   - the file itself, watched so edits land on a later turn rather than
//     requiring a restart. The watch is registered even when the file is absent,
//     so creating it is picked up too.
//   - the maintenance policy: the standing instruction about *when* to update
//     memory. It goes in the system prompt rather than into the file, so the
//     agent never edits the rules it is being given.
//
// Known limit: neither half reaches a delegated Claude Code session. Those turns
// send no system prompt and forward only user text
// (plugin/redsun/claude-code/language-model.ts), so Claude Code gets project
// memory through its own CLAUDE.md instead.
export * as RedsunProjectMemory from "./project-memory.js"

import path from "node:path"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect, PubSub, Stream } from "effect"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Watcher } from "../../filesystem/watcher.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"

export const RELATIVE_PATH = path.join(".redsun", "memory.md")

/**
 * Ported from V1. Deliberately narrow: memory is for knowledge that outlives the
 * session and is not already recorded by the repository itself.
 */
export const POLICY = `<project_memory>
The project memory file at ${RELATIVE_PATH} is durable knowledge about this project, and its contents are part of your instructions.

After completing a substantive task the user asked for, update it when you verified something project-wide that is not already obvious from the code: architecture and how components fit together, workflows, test and build commands, merge constraints, or a feature's contract.

Preserve existing entries; edit the relevant section rather than appending a log. Do not record routine edits, questions, plan-only work, or anything speculative, and do not create the file just to have one. If the user asked you not to, do not update it.
</project_memory>`

export const Plugin = define({
  id: "redsun.instruction.project-memory",
  effect: Effect.fn(function* (ctx) {
    const discovery = yield* InstructionDiscovery.Service
    if (!discovery.project) return

    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const watcher = yield* Watcher.Service
    const file = path.join(location.project.directory, RELATIVE_PATH)
    const loaded: { current: string | undefined } = { current: undefined }

    const refresh = Effect.fn("RedsunProjectMemory.refresh")(function* () {
      // An absent file simply contributes nothing, and an unreadable one warns
      // rather than failing session startup.
      loaded.current = yield* fs
        .readFileStringSafe(file)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project memory unreadable", { file, cause }).pipe(Effect.as(undefined)),
          ),
        )
    })

    // Subscribe before the first read so a write that lands between the two is
    // not missed, and subscribe even when the file does not exist yet.
    const changes = yield* PubSub.sliding<string>(1)
    const updates = yield* watcher.subscribe({ path: file, type: "file" })
    yield* updates.pipe(
      Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Stream.fromPubSub(changes).pipe(
      Stream.runForEach(() => refresh().pipe(Effect.andThen(discovery.reload()))),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* refresh()
    yield* discovery.transform((draft) => {
      if (loaded.current === undefined) return
      draft.add({ path: AbsolutePath.make(file), content: loaded.current })
    })

    // The policy describes maintaining a file that exists; with no memory file
    // it would only invite one to be invented.
    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        if (loaded.current === undefined) return
        event.system.push({ type: "text", text: POLICY })
      }),
    )
  }),
})
