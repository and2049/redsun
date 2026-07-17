import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { ShellTool } from "./shell"
import { InstanceState } from "@/effect/instance-state"

const commands = {
  build: "bun run build",
  test: "bun test",
  lint: "bun run lint",
  typecheck: "bun run typecheck",
  format: "bun run format",
} as const

export const ProjectTool = Tool.define(
  "project",
  Effect.gen(function* () {
    const info = yield* ShellTool
    return () =>
      Effect.gen(function* () {
        const shell = yield* info.init()
        return {
          description: "Run a standard project build, test, lint, typecheck, or format command.",
          parameters: Schema.Struct({
            action: Schema.Literals(["build", "test", "lint", "typecheck", "format"]),
            command: Schema.optional(Schema.String),
            timeout: Schema.optional(Schema.Number),
          }),
          execute: (input: { action: keyof typeof commands; command?: string; timeout?: number }, ctx) =>
            Effect.gen(function* () {
              const instance = yield* InstanceState.context
              return yield* shell.execute({
                command: input.command ?? commands[input.action],
                timeout: input.timeout,
                workdir: instance.directory,
              }, ctx)
            }),
        }
      })
  }),
)
