import z from "zod"
import path from "path"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Global } from "../global"
import { NamedError } from "@redsun/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { ToolRegistry } from "../tool/registry"
import { State } from "../project/state"
import { GlobalBus } from "../bus/global"

export namespace Skill {
  const log = Log.create({ service: "skill" })

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    baseDir: z.string(),
    scope: z.enum(["user", "project"]),
    disableModelInvocation: z.boolean(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  const SKILL_GLOB = new Bun.Glob("**/SKILL.md")
  const PROJECT_SKILL_GLOB = new Bun.Glob("**/SKILL.md")
  const USER_SKILL_GLOB = new Bun.Glob("**/SKILL.md")

  async function initState() {
    const skills: Record<string, Info> = {}

    const userDir = path.join(Global.Path.home, ".redsun", "skill")
    await discoverDir(userDir, "user", skills)

    const projectDir = path.join(Instance.directory, ".redsun", "skill")
    await discoverDir(projectDir, "project", skills)

    for (const dir of await Config.directories()) {
      for await (const match of SKILL_GLOB.scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: true,
      })) {
        const md = await ConfigMarkdown.parse(match)
        if (!md) continue

        const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
        if (!parsed.success) continue

        const name = parsed.data.name
        if (skills[name]?.location === match) continue
        if (skills[name]) {
          log.warn("duplicate skill name", {
            name,
            existing: skills[name].location,
            duplicate: match,
          })
        }
        skills[name] = {
          name,
          description: parsed.data.description,
          location: match,
          baseDir: path.dirname(match),
          scope: "project",
          disableModelInvocation: md.data["disable-model-invocation"] === true,
        }
      }
    }

    try {
      const runner = await ToolRegistry.getRunner()
      for (const p of runner.discoveredResources.skillPaths) {
        await loadPath(p, skills)
      }
    } catch {}

    return skills
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

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function all() {
    return state().then((x) => Object.values(x))
  }

  /**
   * Format skills for inclusion in a system prompt as `<available_skills>` XML.
   * Skills with `disableModelInvocation: true` are excluded.
   * Returns an empty string when there are no visible skills.
   */
  export async function formatForPrompt(): Promise<string> {
    const all = await Skill.all()
    const visible = all.filter((s) => !s.disableModelInvocation)
    if (visible.length === 0) return ""

    const lines: string[] = [
      "",
      "The following skills provide specialized instructions for specific tasks.",
      "Use the skill tool to load a skill's full content when the task matches its description.",
      "When a skill file references a relative path, resolve it against the skill's base directory.",
      "",
      "<available_skills>",
    ]
    for (const skill of visible) {
      lines.push("  <skill>")
      lines.push(`    <name>${escapeXml(skill.name)}</name>`)
      lines.push(`    <description>${escapeXml(skill.description)}</description>`)
      lines.push(`    <location>${escapeXml(skill.location)}</location>`)
      lines.push("  </skill>")
    }
    lines.push("</available_skills>")
    return lines.join("\n")
  }

  function escapeXml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  }

  async function discoverDir(dir: string, scope: "user" | "project", skills: Record<string, Info>) {
    const stat = await Bun.file(dir).stat().catch(() => null)
    if (!stat || !stat.isDirectory()) return
    const glob = scope === "user" ? USER_SKILL_GLOB : PROJECT_SKILL_GLOB
    for await (const match of glob.scan({
      cwd: dir,
      absolute: true,
      onlyFiles: true,
      followSymlinks: true,
    })) {
      await loadFile(match, scope, skills)
    }
  }

  async function loadPath(p: string, skills: Record<string, Info>) {
    const stat = await Bun.file(p).stat().catch(() => null)
    if (!stat) return
    if (stat.isDirectory()) {
      const scope: "user" | "project" = p.includes(path.join(Instance.directory, ".redsun")) ? "project" : "user"
      await discoverDir(p, scope, skills)
      return
    }
    if (stat.isFile() && path.basename(p) === "SKILL.md") {
      const scope: "user" | "project" = p.includes(path.join(Instance.directory, ".redsun")) ? "project" : "user"
      await loadFile(p, scope, skills)
    }
  }

  async function loadFile(filePath: string, scope: "user" | "project", skills: Record<string, Info>) {
    let md: Awaited<ReturnType<typeof ConfigMarkdown.parse>>
    try {
      md = await ConfigMarkdown.parse(filePath)
    } catch (err) {
      log.warn("failed to parse skill", { filePath, error: String(err) })
      return
    }
    if (!md || !md.data) return

    const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
    if (!parsed.success) return

    const name = parsed.data.name
    if (skills[name]) {
      log.warn("duplicate skill name", {
        name,
        existing: skills[name].location,
        duplicate: filePath,
      })
    }
    skills[name] = {
      name,
      description: parsed.data.description,
      location: filePath,
      baseDir: path.dirname(filePath),
      scope,
      disableModelInvocation: md.data["disable-model-invocation"] === true,
    }
  }
}
