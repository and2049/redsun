import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { createInterface } from "readline"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import { Permission } from "../permission"
import { Agent } from "@/agent/agent"
import { iife } from "@/util/iife"

const DEFAULT_READ_LIMIT = 400
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const SAMPLE_BYTES = 4096
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The path to the file to read"),
    offset: z.coerce.number().describe("The line number to start reading from (0-based)").optional(),
    limit: z.coerce.number().describe("The number of lines to read (defaults to 400)").optional(),
  }),
  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.join(Instance.directory, filepath)
    }
    const title = path.relative(Instance.worktree, filepath)
    const agent = await Agent.get(ctx.agent)

    if (!ctx.extra?.["bypassCwdCheck"] && !Instance.containsPath(filepath)) {
      const parentDir = path.dirname(filepath)
      if (agent.permission.external_directory === "ask") {
        await Permission.ask({
          type: "external_directory",
          pattern: [parentDir, path.join(parentDir, "*")],
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          title: `Access file outside working directory: ${filepath}`,
          metadata: {
            filepath,
            parentDir,
          },
        })
      } else if (agent.permission.external_directory === "deny") {
        throw new Permission.RejectedError(
          ctx.sessionID,
          "external_directory",
          ctx.callID,
          {
            filepath: filepath,
            parentDir,
          },
          `File ${filepath} is not in the current working directory`,
        )
      }
    }

    const block = iife(() => {
      const basename = path.basename(filepath)
      const whitelist = [".env.sample", ".env.example", ".example", ".env.template"]

      if (whitelist.some((w) => basename.endsWith(w))) return false
      // Block .env, .env.local, .env.production, etc. but not .envrc
      if (/^\.env(\.|$)/.test(basename)) return true

      return false
    })

    if (block) {
      throw new Error(`The user has blocked you from reading ${filepath}, DO NOT make further attempts to read it`)
    }

    const file = Bun.file(filepath)
    if (!(await file.exists())) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      const dirEntries = await fs.promises.readdir(dir).catch(() => [])
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }

    const stat = await file.stat()
    const sample = await readSample(filepath, stat.size)
    const mime = sniffAttachmentMime(sample, file.type)
    const isImage = SUPPORTED_IMAGE_MIMES.has(mime)
    const isPdf = mime === "application/pdf"
    if (isImage || isPdf) {
      const msg = `${isImage ? "Image" : "PDF"} read successfully`
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
        },
        attachments: [
          {
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(await file.bytes()).toString("base64")}`,
          },
        ],
      }
    }

    const isBinary = isBinaryFile(filepath, sample)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0
    const stream = fs.createReadStream(filepath, { encoding: "utf8" })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    const raw: string[] = []
    let totalLines = 0
    let bytes = 0
    let hasMoreLines = false
    let truncatedByBytes = false
    try {
      for await (const text of lines) {
        totalLines++
        if (totalLines <= offset) continue
        if (raw.length >= limit) {
          hasMoreLines = true
          break
        }

        const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
        const size = Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0)
        if (bytes + size > MAX_BYTES) {
          truncatedByBytes = true
          hasMoreLines = true
          break
        }
        raw.push(line)
        bytes += size
      }
    } finally {
      lines.close()
      stream.destroy()
    }
    if (totalLines <= offset && !(totalLines === 0 && offset === 0)) {
      throw new Error(`Offset ${offset} is out of range for this file (${totalLines} lines)`)
    }
    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = "<file>\n"
    output += content.join("\n")

    const lastReadLine = offset + content.length

    if (truncatedByBytes) {
      output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Use offset=${lastReadLine} to continue.)`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</file>"

    // just warms the lsp client
    void LSP.touchFile(filepath, false).catch(() => {})
    FileTime.read(ctx.sessionID, filepath)

    return {
      title,
      output,
      metadata: {
        preview,
      },
    }
  },
})

async function readSample(filepath: string, fileSize: number) {
  if (fileSize === 0) return new Uint8Array()
  const handle = await fs.promises.open(filepath, "r")
  try {
    const bytes = Buffer.alloc(Math.min(SAMPLE_BYTES, fileSize))
    const result = await handle.read(bytes, 0, bytes.length, 0)
    return bytes.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp"
  }
  return fallback
}

function isBinaryFile(filepath: string, bytes: Uint8Array): boolean {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  if (bytes.length === 0) return false

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}
