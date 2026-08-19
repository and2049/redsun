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
      loaded.current = yield* fs
        .readFileStringSafe(file)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project memory unreadable", { file, cause }).pipe(Effect.as(undefined)),
          ),
        )
    })

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

    yield* ctx.session.hook("context", (event) =>
      Effect.sync(() => {
        if (loaded.current === undefined) return
        event.system.push({ type: "text", text: POLICY })
      }),
    )
  }),
})
