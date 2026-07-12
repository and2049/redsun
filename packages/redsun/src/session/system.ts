import { Ripgrep } from "../file/ripgrep"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import { Skill } from "../skill"
import { MCP } from "../mcp"

import { Instance } from "../project/instance"
import path from "path"
import os from "os"
import { fileURLToPath } from "bun"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_META from "./prompt/meta.txt"
import PROMPT_ANTHROPIC_SPOOF from "./prompt/anthropic_spoof.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import type { Provider } from "@/provider/provider"
import { ContextOptimizer } from "./context-optimizer"

export namespace SystemPrompt {
  export function header(providerID: string) {
    if (providerID.includes("anthropic")) return [PROMPT_ANTHROPIC_SPOOF.trim()]
    return []
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("muse-spark")) return [PROMPT_META]
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function environmentStable() {
    const project = Instance.project
    return [
      [
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `</env>`,
      ].join("\n"),
    ]
  }

  export async function environmentVolatile() {
    const project = Instance.project
    const tree =
      project.vcs === "git"
        ? ContextOptimizer.boundVolatile(
            "volatile file tree",
            await Ripgrep.tree({
              cwd: Instance.directory,
              limit: 200,
            }),
          )
        : ""
    return [
      ContextOptimizer.boundVolatile("volatile environment", [
        `<env_dynamic>`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env_dynamic>`,
        `<files>`,
        `  ${tree}`,
        `</files>`,
      ].join("\n")),
    ]
  }

  const LOCAL_RULE_FILES = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTEXT.md", // deprecated
  ]
  const GLOBAL_RULE_FILES = [
    path.join(Global.Path.config, "AGENTS.md"),
    path.join(os.homedir(), ".claude", "CLAUDE.md"),
  ]

  export async function skills() {
    return ContextOptimizer.boundText("skills prompt", await Skill.formatForPrompt())
  }

  export async function mcp() {
    const instructions = await MCP.instructions()
    if (instructions.length === 0) return undefined
    return ContextOptimizer.boundText("mcp instructions", [
      "<mcp_instructions>",
      ...instructions.flatMap((item) => [
        `  <server name="${item.name}">`,
        ...item.instructions.split("\n").map((line) => `    ${line}`),
        "  </server>",
      ]),
      "</mcp_instructions>",
    ].join("\n"))
  }

  const _docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs")

  export function selfModification() {
    return [
      [
        `<self_modification>`,
        `You can extend redsun by creating extensions, skills, or prompt templates.`,
        `Documentation files are available at:`,
        `- Extensions: ${path.join(_docsDir, "extensions.md")}`,
        `- Skills: ${path.join(_docsDir, "skills.md")}`,
        `- Prompt templates: ${path.join(_docsDir, "prompt-templates.md")}`,
        `Read the appropriate documentation when you need to:`,
        `- Create a new extension (custom tool, command, or event handler)`,
        `- Create a new skill (specialized knowledge/workflow for the agent)`,
        `- Create a new prompt template (reusable prompt with argument substitution)`,
        `After writing extension files to disk, use the reload tool to pick up the changes.`,
        `Extension files must use inline { id, init } tool definitions — you cannot import redsun internals from extensions.`,
        `</self_modification>`,
      ].join("\n"),
    ]
  }

  export function projectMemory() {
    return [
      [
        `<project_memory>`,
        `Maintain long-term project context by reading and writing to the memory file located at \`.redsun/memory.md\`.`,
        `When starting a task, read this file to understand the project's current state and rules.`,
        `When finishing a significant milestone or learning something new about the project, update this file so future sessions have the context.`,
        `</project_memory>`,
      ].join("\n"),
    ]
  }

  export function goalFeature() {
    return [
      [
        `<goal_feature>`,
        `You can use the \`/goal <condition>\` command to set a persistent stop-condition for your session.`,
        `When a goal is active, you will not be allowed to exit the session until an independent judge model evaluates the transcript and confirms the condition is met.`,
        `This is extremely useful for complex tasks to prevent you from stopping prematurely.`,
        `</goal_feature>`,
      ].join("\n"),
    ]
  }

  export async function custom() {
    const config = await Config.get()
    const paths = new Set<string>()

    for (const localRuleFile of LOCAL_RULE_FILES) {
      const matches = await Filesystem.findUp(localRuleFile, Instance.directory, Instance.worktree)
      if (matches.length > 0) {
        matches.forEach((path) => paths.add(path))
        break
      }
    }

    for (const globalRuleFile of GLOBAL_RULE_FILES) {
      if (await Bun.file(globalRuleFile).exists()) {
        paths.add(globalRuleFile)
        break
      }
    }

    if (config.instructions) {
      for (let instruction of config.instructions) {
        if (instruction.startsWith("~/")) {
          instruction = path.join(os.homedir(), instruction.slice(2))
        }
        let matches: string[] = []
        if (path.isAbsolute(instruction)) {
          matches = await Array.fromAsync(
            new Bun.Glob(path.basename(instruction)).scan({
              cwd: path.dirname(instruction),
              absolute: true,
              onlyFiles: true,
            }),
          ).catch(() => [])
        } else {
          matches = await Filesystem.globUp(instruction, Instance.directory, Instance.worktree).catch(() => [])
        }
        matches.forEach((path) => paths.add(path))
      }
    }

    const found = Array.from(paths).map((p) =>
      Bun.file(p)
        .text()
        .catch(() => "")
        .then((x) => ContextOptimizer.boundText(`instructions file ${p}`, "Instructions from: " + p + "\n" + x)),
    )
    return Promise.all(found).then((result) => result.filter(Boolean))
  }
}
