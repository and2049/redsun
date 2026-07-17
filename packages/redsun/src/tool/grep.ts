import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"
import path from "path"
import { Filesystem } from "../util/filesystem"
import { Agent } from "../agent/agent"
import { Permission } from "../permission"

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    const requested = params.path || Instance.directory
    const searchPath = path.isAbsolute(requested) ? requested : path.join(Instance.directory, requested)
    if (!Instance.containsPath(searchPath)) {
      const agent = await Agent.get(ctx.agent)
      const parentDir = path.dirname(searchPath)
      if (agent.permission.external_directory === "ask") {
        await Permission.ask({
          type: "external_directory",
          pattern: [searchPath, path.join(parentDir, "*")],
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          title: `Search outside working directory: ${searchPath}`,
          metadata: { searchPath },
        })
      } else if (agent.permission.external_directory === "deny") {
        throw new Permission.RejectedError(
          ctx.sessionID,
          "external_directory",
          ctx.callID,
          { searchPath },
          `Path ${searchPath} is not in the current working directory`,
        )
      }
    }

    const rgPath = await Ripgrep.filepath()
    const args = ["-nH", "--field-match-separator=|", "--regexp", params.pattern]
    if (params.include) {
      args.push("--glob", params.include)
    }
    args.push(searchPath)

    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })

    const output = await new Response(proc.stdout).text()
    const errorOutput = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    if (exitCode === 1) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    if (exitCode !== 0) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    // Handle both Unix (\n) and Windows (\r\n) line endings
    const lines = output.trim().split(/\r?\n/)
    const matches = []

    for (const line of lines) {
      if (!line) continue

      const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
      if (!filePath || !lineNumStr || lineTextParts.length === 0) continue

      const lineNum = parseInt(lineNumStr, 10)
      const lineText = lineTextParts.join("|")

      const file = Bun.file(filePath)
      const stats = await file.stat().catch(() => null)
      if (!stats) continue

      matches.push({
        path: filePath,
        modTime: stats.mtime.getTime(),
        lineNum,
        lineText,
      })
    }

    matches.sort((a, b) => b.modTime - a.modTime)

    const limit = 100
    const truncated = matches.length > limit
    const finalMatches = truncated ? matches.slice(0, limit) : matches

    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    const outputLines = [`Found ${finalMatches.length} matches`]

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("")
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`)
      }
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (truncated) {
      outputLines.push("")
      outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)")
    }

    return {
      title: params.pattern,
      metadata: {
        matches: finalMatches.length,
        truncated,
      },
      output: outputLines.join("\n"),
    }
  },
})
