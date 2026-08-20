export * as RedsunMultiedit from "./multiedit.js"

import { ToolFailure } from "@opencode-ai/ai"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { Bom } from "@opencode-ai/util/bom"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileMutation } from "../../file-mutation.js"
import { Formatter } from "../../formatter.js"
import { Location } from "../../location.js"
import { LocationMutation } from "../../location-mutation.js"
import { Permission } from "../../permission.js"
import { fileDiff } from "../../tool/plugin/file-diff.js"
import { findMatches } from "../../tool/plugin/edit.js"

export const NAME = "multiedit"

const crlf = "\r\n"

export const Edit = Schema.Struct({
  oldString: Schema.String.annotate({ description: "Exact text to find and replace" }),
  newString: Schema.String.annotate({ description: "Text to replace oldString with (must differ from oldString)" }),
  replaceAll: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether to replace every occurrence of oldString. Defaults to false.",
  }),
})

export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "File to edit" }),
  edits: Schema.Array(Edit).annotate({
    description: "Ordered edits applied sequentially; each operates on the result of the previous one",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
})

export const DESCRIPTION =
  "Apply several exact find-and-replace edits to ONE file in a single call. Edits run in order, each against the result of the previous edit, and the whole call is atomic: if any edit fails, nothing is written. Each edit follows the edit tool's rules — oldString must match exactly (preserve indentation, omit line-number prefixes) and must be unique unless replaceAll is true. Prefer this over several edit calls when making multiple changes to the same file."

export const Plugin = define({
  id: "redsun.tool.multiedit",
  effect: Effect.fn(function* (ctx) {
    const mutation = yield* LocationMutation.Service
    const fileMutation = yield* FileMutation.Service
    const environment = yield* Environment.Service
    const formatter = yield* Formatter.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name: NAME,
          options: { codemode: false, permission: "edit" },
          description: DESCRIPTION,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.edits.length === 0)
                return yield* new ToolFailure({ message: "No edits to apply: edits is empty." })

              const target = yield* mutation.resolve({ path: input.path, kind: "file" })
              const external = target.externalDirectory
              if (external) {
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
              }

              const original = yield* FileMutation.readText(environment.files, target.absolute).pipe(
                Effect.catchTag("Environment.NotFound", () =>
                  Effect.fail(new ToolFailure({ message: `File not found: ${input.path}` })),
                ),
                Effect.catchTag("Environment.WrongKind", (error) =>
                  error.actual === "directory"
                    ? Effect.fail(new ToolFailure({ message: `Path is a directory, not a file: ${input.path}` }))
                    : Effect.fail(new ToolFailure({ message: `Unable to edit ${input.path}`, error })),
                ),
              )
              const source = original.text
              const ending = source.includes(crlf) ? crlf : "\n"

              // All edits apply in memory first; any failure leaves the file untouched.
              let content = source
              let replacements = 0
              for (const [index, edit] of input.edits.entries()) {
                const label = `Edit ${index + 1} of ${input.edits.length}`
                if (edit.oldString === edit.newString)
                  return yield* new ToolFailure({
                    message: `${label}: no changes to apply — oldString and newString are identical.`,
                  })
                if (edit.oldString === "")
                  return yield* new ToolFailure({ message: `${label}: oldString must not be empty.` })
                const oldString = edit.oldString.replaceAll(crlf, "\n").replaceAll("\n", ending)
                const newString = edit.newString.replaceAll(crlf, "\n").replaceAll("\n", ending)
                const matches = findMatches(content, oldString)
                if (matches.length === 0)
                  return yield* new ToolFailure({
                    message: `${label}: could not find oldString in ${input.path}. It must match exactly, including whitespace and indentation. Later edits see earlier edits' results.`,
                  })
                if (matches.length > 1 && edit.replaceAll !== true)
                  return yield* new ToolFailure({
                    message: `${label}: found ${matches.length} matches for oldString, but expected exactly one. Add more surrounding context, or set replaceAll to true.`,
                  })
                const applied = edit.replaceAll === true ? matches : matches.slice(0, 1)
                replacements += applied.length
                content = applied
                  .toReversed()
                  .reduce(
                    (value, match) => `${value.slice(0, match.start)}${newString}${value.slice(match.end)}`,
                    content,
                  )
              }

              yield* permission.assert({
                action: "edit",
                resources: [target.resource],
                save: ["*"],
                metadata: { files: [fileDiff(target.resource, source, content)] },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })

              const replacementBom = content.startsWith("﻿")
              const bom = original.bom || replacementBom
              const result = yield* fileMutation.write({ target, content: Bom.join(content, bom) })
              const formatted = (yield* formatter.file(target.absolute))
                ? yield* FileMutation.syncTextBom(environment.files, target.absolute, bom)
                : (yield* FileMutation.readText(environment.files, target.absolute)).text
              return {
                files: [fileDiff(result.resource, source, formatted)],
                replacements,
              } satisfies typeof Output.Type
            }).pipe(
              fileMutation.withLock([path.resolve(location.directory, input.path)]),
              Effect.map((output) => ({
                output,
                content: `Edited ${output.files[0]?.file} (${input.edits.length} edit${input.edits.length === 1 ? "" : "s"}, ${output.replacements} replacement${output.replacements === 1 ? "" : "s"})`,
                metadata: { files: output.files },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to edit ${input.path}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
})
