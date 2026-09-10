/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill.js"

import { define, type Context } from "@opencode/plugin/effect/plugin"
import { Document } from "@opencode/schema/config"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import { Config } from "../config.js"
import opencodeContent from "./skill/opencode.md" with { type: "text" }
import reportContent from "./skill/report.md" with { type: "text" }
import { pages as docPages, source as docSource } from "./skill/docs/index.js"

export const OpencodeContent = opencodeContent
export const ReportContent = reportContent

export const OpencodeDescription =
  "Use this skill for any question about redsun itself, including how redsun works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using its clients, server, or API, and contributing to the redsun codebase. Also use it for redsun agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app."
const REPORT_DESCRIPTION =
  "Use when the user wants to report a redsun issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI."

export const DOCS_PLACEHOLDER = "{{DOCS_DIR}}"
export const docsDirectory = () => path.join(Global.Path.data, "docs")
export const skillContent = (directory: string) => OpencodeContent.replaceAll(DOCS_PLACEHOLDER, directory)

export const Plugin = define({
  id: "opencode.skill",
  effect: Effect.fn(function* (ctx) {
    const reportContent = yield* reportContentWithDiagnostics(ctx.app)
    const directory = docsDirectory()
    yield* materializeDocs(ctx.app, directory).pipe(
      Effect.catchCause((cause) => Effect.logWarning("failed to write redsun docs", { directory, cause })),
    )
    yield* ctx.skill.transform((editor) => {
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("redsun"),
          name: Skill.Name.make("redsun"),
          description: OpencodeDescription,
          location: AbsolutePath.make(path.join(directory, "SKILL.md")),
          content: skillContent(directory),
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("report"),
          name: Skill.Name.make("Report"),
          description: REPORT_DESCRIPTION,
          slash: true,
          location: AbsolutePath.make("/builtin/report.md"),
          content: reportContent,
        }),
      )
    })
  }),
})

const materializeDocs = Effect.fn("SkillPlugin.materializeDocs")(function* (app: Context["app"], directory: string) {
  const stamp = `${app.version} ${docSource}`
  const marker = path.join(directory, ".stamp")
  const current = yield* Effect.promise(() => fs.promises.readFile(marker, "utf8").catch(() => undefined))
  if (current === stamp && app.channel !== "local") return
  yield* Effect.promise(async () => {
    await fs.promises.rm(directory, { recursive: true, force: true })
    for (const page of [...docPages, { path: "SKILL.md", content: skillContent(directory) }]) {
      const target = path.join(directory, page.path)
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      await fs.promises.writeFile(target, page.content)
    }
    await fs.promises.writeFile(marker, stamp)
  })
})

const reportContentWithDiagnostics = Effect.fn("SkillPlugin.reportContentWithDiagnostics")(function* (
  app: Context["app"],
) {
  const plugins = yield* configuredPlugins()
  return [
    ReportContent,
    "",
    "## Runtime Diagnostics Snapshot",
    "",
    "These values were captured when the built-in report skill was registered. Verify them before publishing.",
    "",
    `- redsun version: ${app.version}`,
    `- install/channel: ${app.channel}`,
    `- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
    `- Terminal: ${terminal()}`,
    `- Shell: ${shell()}`,
    `- Active plugins: ${plugins.length === 0 ? "None found in config" : plugins.join(", ")}`,
  ].join("\n")
})

const configuredPlugins = Effect.fn("SkillPlugin.configuredPlugins")(function* () {
  const config = yield* Config.Service
  return (yield* config.entries())
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => entry.info.plugins ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry.package))
    .toSorted()
})

function terminal() {
  return (
    [
      process.env.TERM_PROGRAM ? `TERM_PROGRAM=${process.env.TERM_PROGRAM}` : undefined,
      process.env.TERM ? `TERM=${process.env.TERM}` : undefined,
      process.env.COLORTERM ? `COLORTERM=${process.env.COLORTERM}` : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(", ") || "Unavailable: terminal environment variables are not set"
  )
}

function shell() {
  return (
    process.env.SHELL ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    "Unavailable: shell environment variable is not set"
  )
}
