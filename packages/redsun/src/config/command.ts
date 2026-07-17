export * as ConfigCommand from "./command"

import path from "path"
import { Cause, Exit, Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigCommandV1 } from "@opencode-ai/core/v1/config/command"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "@opencode-ai/core/v1/config/error"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"

const decodeInfo = Schema.decodeUnknownExit(ConfigCommandV1.Info)

export async function load(dir: string) {
  const result: Record<string, ConfigCommandV1.Info> = {}
  for (const item of await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])

    const config = {
      name,
      ...md.data,
      template: md.content.trim(),
    }
    const parsed = decodeInfo(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = parsed.value
      continue
    }
    throw new InvalidError({ path: item, message: Cause.pretty(parsed.cause) }, { cause: Cause.squash(parsed.cause) })
  }
  return result
}

export async function loadPaths(paths: string[]) {
  const result: Record<string, ConfigCommandV1.Info> = {}
  for (const root of paths) {
    const info = await Bun.file(root).stat().catch(() => undefined)
    const files = info?.isDirectory()
      ? await Glob.scan("**/*.md", { cwd: root, absolute: true, dot: true, symlink: true })
      : info?.isFile() && root.endsWith(".md")
        ? [root]
        : []
    for (const item of files) {
      const md = await ConfigMarkdown.parse(item).catch(() => undefined)
      if (!md) continue
      const name = typeof md.data.name === "string" && md.data.name ? md.data.name : path.basename(item, ".md")
      result[name] = ConfigParse.schema(
        ConfigCommandV1.Info,
        {
          ...Object.fromEntries(Object.entries(md.data).filter(([key]) => key !== "name")),
          template: md.content.trim(),
        },
        item,
      )
    }
  }
  return result
}
