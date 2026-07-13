import z from "zod"
import path from "path"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Global } from "../global"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { ToolRegistry } from "../tool/registry"
import { State } from "../project/state"
import { GlobalBus } from "../bus/global"

export namespace PromptTemplate {
  const log = Log.create({ service: "prompt.template" })

  const Argument = z.object({
    name: z.string(),
    description: z.string().optional(),
    default: z.string().optional(),
  })

  export const Info = z
    .object({
      name: z.string(),
      description: z.string(),
      arguments: z.array(Argument).optional(),
      content: z.string(),
      filePath: z.string(),
      scope: z.enum(["user", "project"]),
    })
    .meta({ ref: "PromptTemplate" })
  export type Info = z.infer<typeof Info>

  const PROMPT_GLOB = new Bun.Glob("*.md")

  async function initState() {
    const result: Record<string, Info> = {}

    const home = path.join(Global.Path.home, ".redsun", "prompts")
    await discoverDir(home, "user", result)

    const project = path.join(Instance.directory, ".redsun", "prompts")
    await discoverDir(project, "project", result)

    for (const configDir of await Config.directories()) {
      const nested = path.join(configDir, "prompts")
      await discoverDir(nested, "project", result)
    }

    try {
      const runner = await ToolRegistry.getRunner()
      for (const p of runner.discoveredResources.promptPaths) {
        await loadPath(p, result)
      }
    } catch {}

    return result
  }

  export const state = Instance.state(initState)

  export function invalidate(directory = Instance.directory) {
    State.reset(directory, initState)
  }

  GlobalBus.on("event", (evt) => {
    if (evt.payload?.type === "tool.registry.changed" && evt.directory) {
      invalidate(evt.directory)
    }
  })

  export async function all(): Promise<Info[]> {
    const s = await state()
    return Object.values(s)
  }

  export async function get(name: string): Promise<Info | undefined> {
    const s = await state()
    return s[name]
  }

  /**
   * Substitute argument placeholders in template content.
   *
   * Supports:
   * - `{{argName}}` for named arguments (uses `args` or frontmatter `default`).
   * - `$ARGUMENTS` / `$@` for the full raw arguments string.
   * - `$1`, `$2`, ... for positional arguments.
   *
   * Named-argument placeholders fall back to the frontmatter `default`
   * when the argument is missing, and to an empty string otherwise.
   * Recursive substitution of patterns inside substituted values is NOT performed.
   */
  export function substitute(
    content: string,
    rawArgs: string,
    args: Record<string, string> = {},
    argDefs?: Array<{ name: string; default?: string }>,
  ): string {
    const positional = rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
    const cleaned = positional.map((p) => p.replace(/^["']|["']$/g, ""))

    const allArgs = rawArgs.trim()

    const resolved: Record<string, string> = {}
    if (argDefs) {
      for (let i = 0; i < argDefs.length; i++) {
        const def = argDefs[i]
        const fromUser = args[def.name]
        if (fromUser !== undefined) {
          resolved[def.name] = fromUser
          continue
        }
        const fromPositional = cleaned[i]
        if (fromPositional !== undefined) {
          resolved[def.name] = fromPositional
          continue
        }
        if (def.default !== undefined) {
          resolved[def.name] = def.default
          continue
        }
        resolved[def.name] = ""
      }
    }
    for (const [k, v] of Object.entries(args)) {
      if (!(k in resolved)) resolved[k] = v
    }

    let out = content

    out = out.replace(/\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g, (m, key: string) => {
      if (key in resolved) return resolved[key]
      const def = argDefs?.find((d) => d.name === key)
      if (def?.default !== undefined) return def.default
      return ""
    })

    out = out.replace(/\$ARGUMENTS\b/g, allArgs)
    out = out.replace(/\$@/g, allArgs)
    out = out.replace(/\$(\d+)\b/g, (m, idx) => {
      const i = parseInt(idx, 10) - 1
      return cleaned[i] ?? ""
    })

    return out
  }

  async function discoverDir(dir: string, scope: Info["scope"], result: Record<string, Info>) {
    const stat = await Bun.file(dir).stat().catch(() => null)
    if (!stat || !stat.isDirectory()) return
    for await (const match of PROMPT_GLOB.scan({
      cwd: dir,
      absolute: true,
      onlyFiles: true,
    })) {
      await loadFile(match, scope, result)
    }
  }

  async function loadPath(p: string, result: Record<string, Info>) {
    const stat = await Bun.file(p).stat().catch(() => null)
    if (!stat) return
    if (stat.isDirectory()) {
      const scope: Info["scope"] = p.includes(path.join(Instance.directory, ".redsun")) ? "project" : "user"
      await discoverDir(p, scope, result)
      return
    }
    if (stat.isFile() && p.endsWith(".md")) {
      const scope: Info["scope"] = p.includes(path.join(Instance.directory, ".redsun")) ? "project" : "user"
      await loadFile(p, scope, result)
    }
  }

  async function loadFile(filePath: string, scope: Info["scope"], result: Record<string, Info>) {
    let md: ReturnType<typeof ConfigMarkdown.parse> extends Promise<infer R> ? Awaited<R> : never
    try {
      md = (await ConfigMarkdown.parse(filePath)) as any
    } catch (err) {
      log.warn("failed to parse prompt template", { filePath, error: String(err) })
      return
    }
    if (!md || !md.data) return

    const nameFromFrontmatter = (md.data as Record<string, unknown>).name
    const descriptionFromFrontmatter = (md.data as Record<string, unknown>).description
    const argumentsFromFrontmatter = (md.data as Record<string, unknown>).arguments

    const name =
      typeof nameFromFrontmatter === "string" && nameFromFrontmatter.length > 0
        ? nameFromFrontmatter
        : path.basename(filePath, ".md")

    if (result[name]) {
      log.warn("duplicate prompt template name", {
        name,
        existing: result[name].filePath,
        duplicate: filePath,
      })
    }

    const rawDescription =
      typeof descriptionFromFrontmatter === "string" && descriptionFromFrontmatter.length > 0
        ? descriptionFromFrontmatter
        : (md.content ?? "")
            .split("\n")
            .map((l: string) => l.trim())
            .find((l: string) => l.length > 0)
            ?.slice(0, 80) ?? ""

    let args: Array<{ name: string; description?: string; default?: string }> | undefined
    if (Array.isArray(argumentsFromFrontmatter)) {
      const parsed = z.array(Argument).safeParse(argumentsFromFrontmatter)
      if (parsed.success) {
        args = parsed.data
      }
    }

    result[name] = {
      name,
      description: rawDescription,
      arguments: args,
      content: (md.content ?? "").trim(),
      filePath,
      scope,
    }
  }
}
