import { spawn } from "child_process"
import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { detectProfile } from "../project/toolchain"
import { Shell } from "../shell/shell"

const MAX_OUTPUT_LENGTH = 10_000
const SOFT_KILL_GRACE_MS = 3_000

function shellQuote(s: string): string {
  if (!s) return s
  if (/^[a-zA-Z0-9_./@~-]+$/.test(s)) return s
  return `"${s.replace(/[\\"]/g, "\\$&")}"`
}

async function runCommand(
  cmd: string,
  cwd: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, {
      shell: Shell.acceptable() || true,
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let killed = false

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const hardKill = () => {
      killed = true
      Shell.killTree(proc, { exited: () => false })
    }

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      setTimeout(hardKill, SOFT_KILL_GRACE_MS)
    }, timeout)

    proc.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut })
    })

    proc.on("error", () => {
      clearTimeout(timer)
      if (!killed) resolve({ stdout, stderr, exitCode: 1, timedOut })
    })
  })
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output
  return output.slice(0, MAX_OUTPUT_LENGTH) + "\n... [output truncated]"
}

export function formatActionResult(name: string, result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean }): string {
  if (result.timedOut) return `✗ ${name} (timed out)`
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
  const truncated = truncateOutput(output)
  if (result.exitCode === 0) {
    const warning = output.match(/(\d+) (warning|error)/i)
    if (warning) return `✓ ${name} (${warning[1]} ${warning[2]}s)\n${truncated.split("\n").slice(0, 5).join("\n")}`
    return `✓ ${name}`
  }
  return `✗ ${name}\n${truncated.split("\n").slice(0, 10).join("\n")}`
}

const FIX_RULES: Array<{ match: RegExp; apply: (cmd: string) => string }> = [
  { match: /biome/, apply: (c) => c.includes("--write") ? c : c.replace(/(biome\s+\w+)/, "$1 --write --unsafe") },
  { match: /eslint/, apply: (c) => `${c} --fix` },
  { match: /oxlint/, apply: (c) => `${c} --fix` },
  { match: /ruff\s+check/, apply: (c) => c.replace("ruff check", "ruff check --fix") },
  { match: /ruff\s+format/, apply: (c) => c.replace(/--check\s*/, "").trim() },
  { match: /clippy/, apply: (c) => `${c} --fix --allow-dirty` },
  { match: /cargo\s+fmt/, apply: (c) => c.replace(/--check\s*/, "").trim() },
  { match: /prettier/, apply: (c) => c.includes("--write") ? c : c.replace("--check", "--write") },
  { match: /golangci-lint/, apply: (c) => `${c} --fix` },
  { match: /black/, apply: (c) => c },
  { match: /isort/, apply: (c) => `${c}` },
  { match: /php-cs-fixer/, apply: (c) => c.replace("--dry-run", "") },
  { match: /pint/, apply: (c) => `${c}` },
  { match: /rubocop/, apply: (c) => `${c} -a` },
  { match: /ktlint/, apply: (c) => `${c} --format` },
  { match: /swiftlint/, apply: (c) => `${c} --fix` },
  { match: /clang-tidy/, apply: (c) => `${c} --fix` },
  { match: /dotnet\s+format/, apply: (c) => `${c}` },
  { match: /stylua/, apply: (c) => `${c}` },
  { match: /shfmt/, apply: (c) => `${c}` },
  { match: /dprint/, apply: (c) => `${c}` },
]

export function applyFixFlag(cmd: string): string {
  for (const rule of FIX_RULES) {
    if (rule.match.test(cmd)) return rule.apply(cmd)
  }
  return cmd
}

export const ProjectTool = Tool.define("project", async () => {
  const description = [
    `[TIER-1] Verify after every edit — auto-detected toolchain.`,
    `Actions: check (typecheck+lint+test in parallel), test, build, lint, typecheck, format.`,
    `Use check after edits for full verification in one call.`,
    `Fix only the failed step, then re-run just that action.`,
  ].join(" ")

  return {
    description,
    parameters: z.object({
      action: z.enum(["check", "test", "build", "lint", "typecheck", "format"]).describe("Project action to run"),
      file: z.string().optional().describe("Target file or directory (for test/lint)"),
      fix: z.boolean().optional().describe("Auto-fix lint/format issues"),
      timeout: z.number().optional().describe("Timeout in milliseconds (default 120000)"),
    }),
    async execute(params, ctx) {
      const pathMod = await import("path")
      const resolvedFile = params.file ? pathMod.resolve(Instance.directory, params.file) : undefined
      const baseDir = resolvedFile ? pathMod.dirname(resolvedFile) : Instance.directory
      const timeout = params.timeout ?? 120_000
      const profile = await detectProfile(Instance.directory)

      const appendFile = (cmd: string): string => {
        if (!resolvedFile) return cmd
        return `${cmd} ${shellQuote(resolvedFile)}`
      }

      if (params.action === "check") {
        const steps: Array<{ name: string; cmd: string | null }> = [
          { name: "typecheck", cmd: profile.typecheck },
          { name: "lint", cmd: profile.lint },
          { name: "test", cmd: profile.test },
        ]

        const available = steps.filter((s): s is { name: string; cmd: string } => s.cmd != null)
        if (available.length === 0) {
          return { title: "check", metadata: {}, output: "No typecheck, lint, or test commands detected for this project." }
        }

        ctx.metadata({ metadata: { running: true, steps: available.map(s => s.name) } })

        const results = await Promise.all(
          available.map(async (step) => {
            const cmd = (step.name === "test" || step.name === "lint") ? appendFile(step.cmd) : step.cmd
            const result = await runCommand(cmd, baseDir, timeout)
            return { name: step.name, result }
          }),
        )

        const allPass = results.every((r) => r.result.exitCode === 0 && !r.result.timedOut)
        const lines = results.map((r) => formatActionResult(r.name, r.result))

        return {
          title: allPass ? "check passed" : "check failed",
          metadata: {} as Record<string, unknown>,
          output: lines.join("\n\n"),
        }
      }

      const cmdMap: Record<string, string | null> = {
        test: profile.test,
        build: profile.build,
        lint: profile.lint,
        typecheck: profile.typecheck,
        format: profile.format,
      }

      let cmd = cmdMap[params.action]
      if (!cmd) {
        return {
          title: params.action,
          metadata: {},
          output: `No ${params.action} command detected for this project.`,
        }
      }

      if (params.file && (params.action === "test" || params.action === "lint")) {
        cmd = appendFile(cmd)
      }

      if (params.fix) {
        if (params.action === "format" || params.action === "lint") {
          cmd = applyFixFlag(cmd)
        }
      }

      ctx.metadata({ metadata: { running: true, action: params.action } })

      const result = await runCommand(cmd, baseDir, timeout)
      let output = formatActionResult(params.action, result)

      const passed = result.exitCode === 0 && !result.timedOut

      // Biome format does lint+format in one pass — tell the agent not to re-check
      if (passed && params.action === "format" && profile.lint?.includes("biome")) {
        output += "\n\n✓ formatted & linted, all clean. No need to re-check."
      }

      return {
        title: passed ? `${params.action} passed` : `${params.action} failed`,
        metadata: {} as Record<string, unknown>,
        output,
      }
    },
  }
})
