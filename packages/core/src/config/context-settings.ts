export * as ContextSettings from "./context-settings.js"

import path from "node:path"
import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { Config } from "@opencode/schema/config"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { ConfigDiscovery } from "./discovery.js"
import { ConfigNormalize } from "./normalize.js"
import { ConfigVariable } from "./variable.js"

export interface Interface {
  readonly get: () => Effect.Effect<Config.ContextSettings, Error>
  readonly update: (input: Config.ContextSettings) => Effect.Effect<Config.ContextSettings, Error>
}

export class Service extends Context.Service<Service, Interface>()("redsun/ContextSettings") {}

export class InvalidConfig extends Schema.TaggedError<InvalidConfig>()("ContextSettings.InvalidConfig", {
  message: Schema.String,
}) {}

const error = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const lock = yield* Semaphore.make(1)
    const read = Effect.fnUntraced(function* () {
      return yield* Effect.forEach(ConfigDiscovery.names, (name) =>
        Effect.gen(function* () {
          const file = path.join(global.config, name)
          const text = yield* fs
            .readFileString(file)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined))
          if (text === undefined) return
          const substituted = yield* ConfigVariable.substitute({ type: "path", path: file, text }).pipe(
            Effect.provideService(FSUtil.Service, fs),
            Effect.mapError((cause) => new InvalidConfig({ message: String(cause) })),
          )
          const errors: ParseError[] = []
          const value: unknown = parse(substituted, errors, { allowTrailingComma: true })
          const normalized = ConfigNormalize.normalize(value)
          if (errors.length || normalized.type === "rejected")
            return yield* Effect.fail(new InvalidConfig({ message: `Cannot edit malformed configuration: ${file}` }))
          const info = yield* Schema.decodeUnknownEffect(Config.ContextSettings)(normalized.encoded).pipe(
            Effect.mapError((cause) => new InvalidConfig({ message: String(cause) })),
          )
          return { file, text, info }
        }),
      ).pipe(Effect.map((files) => files.filter((file) => file !== undefined)))
    })
    const resolve = (files: Effect.Success<ReturnType<typeof read>>): Config.ContextSettings =>
      new Config.ContextSettings({
        stale_read_deduplication:
          files.findLast((file) => file.info.stale_read_deduplication !== undefined)?.info.stale_read_deduplication ??
          false,
        compaction: {
          strategy:
            files.findLast((file) => file.info.compaction?.strategy !== undefined)?.info.compaction?.strategy ?? "llm",
        },
      })
    const get = () => read().pipe(Effect.map(resolve), Effect.mapError(error))
    const update = Effect.fn("ContextSettings.update")(
      function* (input: Config.ContextSettings) {
        const files = yield* read()
        const target = files.at(-1) ?? { file: path.join(global.config, "redsun.jsonc"), text: "{}\n" }
        const edits = [
          { path: ["stale_read_deduplication"], value: input.stale_read_deduplication },
          { path: ["compaction", "strategy"], value: input.compaction?.strategy },
        ].filter((edit) => edit.value !== undefined)
        if (!edits.length) return resolve(files)
        const text = yield* Effect.try(() =>
          edits.reduce(
            (text, edit) =>
              applyEdits(
                text,
                modify(text, edit.path, edit.value, {
                  formattingOptions: { tabSize: 2, insertSpaces: true },
                }),
              ),
            target.text,
          ),
        )
        const temporary = `${target.file}.${randomUUID()}.tmp`
        yield* fs.makeDirectory(global.config, { recursive: true })
        yield* Effect.uninterruptible(
          fs
            .writeFileString(temporary, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 })
            .pipe(
              Effect.andThen(fs.rename(temporary, target.file)),
              Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
            ),
        )
        return yield* get()
      },
      (effect) => lock.withPermit(effect).pipe(Effect.mapError(error)),
    )
    return Service.of({ get, update })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })
