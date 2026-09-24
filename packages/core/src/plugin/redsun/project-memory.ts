export * as RedsunProjectMemory from "./project-memory.js"

import path from "node:path"
import { define } from "@opencode/plugin/effect/plugin"
import { Effect, PubSub, Stream } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"

export const RELATIVE_PATH = path.join(".redsun", "memory.md")

/** Files at or under this size load in full even in outline mode: an index would save nothing. */
export const OUTLINE_MIN_CHARS = 8_000
export const OUTLINE_PREAMBLE_MAX_CHARS = 1_500
/** Past this size the index drops its second heading level. */
export const OUTLINE_INDEX_MAX_CHARS = 8_000

export const POLICY = `<project_memory>
The project memory file at ${RELATIVE_PATH} is durable knowledge about this project, and its contents are part of your instructions. When it is loaded as an outline, only its preamble and section index are included: read the sections relevant to your task before starting work in that area, and read a section before editing it.

After completing a substantive task the user asked for, update it when you verified something project-wide that is not already obvious from the code: architecture and how components fit together, workflows, test and build commands, merge constraints, or a feature's contract.

Preserve existing entries; edit the relevant section rather than appending a log. Do not record routine edits, questions, plan-only work, or anything speculative, and do not create the file just to have one. If the user asked you not to, do not update it.
</project_memory>`

type Heading = { readonly level: number; readonly title: string; readonly line: number }

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/

const headings = (lines: readonly string[]) => {
  const found: Heading[] = []
  let fence: string | undefined
  lines.forEach((text, index) => {
    const marker = text.match(FENCE)?.[1]
    if (marker) {
      if (fence === undefined) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      return
    }
    if (fence !== undefined) return
    const match = text.match(HEADING)
    if (match?.[2]) found.push({ level: match[1]!.length, title: match[2], line: index + 1 })
  })
  return found
}

const lastContentLine = (lines: readonly string[], from: number, to: number) => {
  let end = to
  while (end > from && lines[end - 1]!.trim() === "") end--
  return end
}

/**
 * Condense a memory document to its preamble plus an index of its top two heading levels
 * with 1-based line ranges, so the model reads sections on demand. A lone leading H1 is
 * treated as the title. Small or heading-less documents are returned unchanged.
 */
export const outline = (content: string, file: string) => {
  if (content.length <= OUTLINE_MIN_CHARS) return content
  const lines = content.replace(/\n$/, "").split("\n")
  const all = headings(lines)
  const titled = all[0]?.level === 1 && all.filter((heading) => heading.level === 1).length === 1
  const sections = titled ? all.slice(1) : all
  if (sections.length === 0) return content

  const top = Math.min(...sections.map((heading) => heading.level))
  const end = (heading: Heading) => {
    const next = all.find((other) => other.line > heading.line && other.level <= heading.level)
    return lastContentLine(lines, heading.line, next ? next.line - 1 : lines.length)
  }
  const entry = (heading: Heading) =>
    `${"  ".repeat(heading.level - top)}- ${heading.title} (lines ${heading.line}-${end(heading)})`
  const index = (depth: number) =>
    sections
      .filter((heading) => heading.level <= top + depth)
      .map(entry)
      .join("\n")
  const nested = index(1)
  const entries = nested.length <= OUTLINE_INDEX_MAX_CHARS ? nested : index(0)

  const first = sections[0]!.line - 1
  const preamble = lines.slice(0, lastContentLine(lines, 0, first)).join("\n")
  const cut = preamble.lastIndexOf("\n", OUTLINE_PREAMBLE_MAX_CHARS)
  const lead =
    preamble.length <= OUTLINE_PREAMBLE_MAX_CHARS
      ? preamble
      : `${preamble.slice(0, cut > 0 ? cut : OUTLINE_PREAMBLE_MAX_CHARS)}\n[preamble truncated; read lines 1-${first}]`

  return [
    `[redsun: outline of ${file} (${lines.length} lines). Read a section with the read tool: ${file} offset=<first line> limit=<line count>.]`,
    lead,
    `Sections:\n${entries}`,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

export const Plugin = define({
  id: "redsun.instruction.project-memory",
  effect: Effect.fn(function* (ctx) {
    const discovery = yield* InstructionDiscovery.Service
    if (!discovery.project) return

    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const watcher = yield* Watcher.Service
    const file = path.join(location.project.directory, RELATIVE_PATH)
    const loaded: { current: string | undefined } = { current: undefined }

    const refresh = Effect.fn("RedsunProjectMemory.refresh")(function* () {
      const content = yield* fs
        .readFileStringSafe(file)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("project memory unreadable", { file, cause }).pipe(Effect.as(undefined)),
          ),
        )
      const load = Config.latest(yield* config.entries(), "project_memory")?.load ?? "outline"
      loaded.current = content === undefined || load === "full" ? content : outline(content, file)
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

    for (const kind of ["context", "compaction", "generate"] as const)
      yield* ctx.session.hook(kind, (event) =>
        Effect.sync(() => {
          if (loaded.current === undefined) return
          event.system.push({ type: "text", text: POLICY })
        }),
      )
  }),
})
