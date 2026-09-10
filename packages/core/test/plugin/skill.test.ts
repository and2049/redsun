import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Document, Info } from "@opencode/schema/config"
import { Effect, Layer, Stream } from "effect"
import { SkillPlugin } from "@opencode/core/plugin/skill"
import { Skill } from "@opencode/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(Skill.node))
const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )
const config = (plugins: Info["plugins"] = []) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () => Effect.succeed([new Document({ type: "document", info: new Info({ plugins }) })]),
      reload: () => Effect.void,
      changes: () => Stream.never,
    }),
  )

describe("SkillPlugin.Plugin", () => {
  it.effect("registers built-in skills", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* SkillPlugin.Plugin.effect(
        host({
          app: { name: "test", version: "1.2.3", channel: "beta" },
          skill: {
            list: () => Effect.die("unused skill.list"),
            transform: skill.transform,
            reload: skill.reload,
          },
        }),
      ).pipe(Effect.provide(config()))
      const skills = yield* skill.list()
      const report = skills.find((item) => item.id === "report")

      expect(skills).toContainEqual(
        expect.objectContaining({
          id: "redsun",
          name: "redsun",
          description: expect.stringContaining("any question about redsun itself"),
        }),
      )
      expect(skills).toContainEqual(
        expect.objectContaining({
          id: "report",
          name: "Report",
          description: expect.stringContaining("redsun issue"),
        }),
      )
      expect(report?.slash).toBe(true)
      expect(report?.content).toContain("- redsun version: 1.2.3")
      expect(report?.content).toContain("- install/channel: beta")
    }),
  )

  it.effect("writes the vendored docs next to the redsun skill and skips rewrites for a matching stamp", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const directory = SkillPlugin.docsDirectory()
      const page = path.join(directory, "build", "plugins", "cli.md")
      const setup = (app: { version: string; channel: string }) =>
        SkillPlugin.Plugin.effect(
          host({
            app: { name: "test", ...app },
            skill: { list: () => Effect.die("unused skill.list"), transform: skill.transform, reload: skill.reload },
          }),
        ).pipe(Effect.provide(config()))

      yield* setup({ version: "1.2.3", channel: "beta" })
      const redsun = (yield* skill.list()).find((item) => item.id === "redsun")!
      expect(String(redsun.location)).toBe(path.join(directory, "SKILL.md"))
      expect(redsun.content).toContain(directory)
      expect(redsun.content).not.toContain(SkillPlugin.DOCS_PLACEHOLDER)
      expect(yield* Effect.promise(() => fs.readFile(page, "utf8"))).toContain("# CLI")
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "SKILL.md"), "utf8"))).toBe(redsun.content)

      yield* Effect.promise(() => fs.rm(page))
      yield* setup({ version: "1.2.3", channel: "beta" })
      expect(yield* Effect.promise(() => exists(page))).toBe(false)

      yield* setup({ version: "1.2.4", channel: "beta" })
      expect(yield* Effect.promise(() => exists(page))).toBe(true)

      yield* Effect.promise(() => fs.rm(page))
      yield* setup({ version: "1.2.4", channel: "local" })
      expect(yield* Effect.promise(() => exists(page))).toBe(true)
    }),
  )

  it.effect("reports canonical configured plugin sources with existing labels and ordering", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* SkillPlugin.Plugin.effect(
        host({
          skill: {
            list: () => Effect.die("unused skill.list"),
            transform: skill.transform,
            reload: skill.reload,
          },
        }),
      )
      const report = (yield* skill.list()).find((item) => item.id === "report")
      expect(report?.content).toContain("- Active plugins: -disabled, local.ts, package-plugin, package-plugin")
    }).pipe(
      Effect.provide(
        config(["package-plugin", "-disabled", "local.ts", { package: "package-plugin", options: { enabled: true } }]),
      ),
    ),
  )
})
