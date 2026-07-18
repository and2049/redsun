import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import path from "node:path"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "@/patch"

type Guard = { blocked: false } | { blocked: true; reason: string; type: "extension" | "system" }

export function isProtectedPath(filePath: string): Guard {
  const normalized = path.resolve(filePath)
  if (normalized === path.resolve(Global.Path.config, "trust.json")) {
    return { blocked: true, reason: `Cannot write to protected path: ${filePath}`, type: "system" }
  }

  const basename = path.basename(normalized).toLowerCase()
  if (basename === ".env" || basename.startsWith(".env.") || basename === ".envrc" || basename.startsWith(".envrc.")) {
    return { blocked: true, reason: `Cannot write to protected file: ${filePath}`, type: "system" }
  }

  const segments = normalized.split(path.sep).map((segment) => segment.toLowerCase())
  if (segments.includes(".git") || segments.includes("node_modules")) {
    return { blocked: true, reason: `Cannot write to protected directory: ${filePath}`, type: "system" }
  }
  for (let index = 0; index < segments.length - 1; index++) {
    if (segments[index] === ".redsun" && segments[index + 1] === "extensions") {
      return { blocked: true, reason: `Cannot write to protected extension directory: ${filePath}`, type: "extension" }
    }
  }
  return { blocked: false }
}

function paths(toolID: string, args: Record<string, unknown>, directory: string) {
  if ((toolID === "write" || toolID === "edit") && typeof args.filePath === "string") return [args.filePath]
  if (toolID === "apply_patch" && typeof args.patchText === "string") {
    try {
      return Patch.parsePatch(args.patchText).hunks.flatMap((hunk) =>
        hunk.type === "update" && hunk.move_path ? [hunk.path, hunk.move_path] : [hunk.path],
      )
    } catch {
      return []
    }
  }
  if (toolID !== "bash" || typeof args.command !== "string") return []
  return args.command
    .split(/[\s'"|;&<>(){}$`]+/)
    .filter((token) => token.length > 1 && (token.includes("/") || token.includes("\\") || token.startsWith(".")))
    .map((token) => token.replace(/[,:]+$/, ""))
    .concat(args.command.includes("trust.json") ? [path.join(Global.Path.config, "trust.json")] : [])
}

export const assertProtectedWrite = Effect.fn("Extension.assertProtectedWrite")(function* (
  toolID: string,
  args: Record<string, unknown>,
  ctx: { ask: (input: any) => Effect.Effect<void> },
) {
  const candidates = new Set(paths(toolID, args, ""))
  if (candidates.size === 0) return
  const instance = yield* InstanceState.context
  for (const candidate of candidates) {
    const filepath = path.isAbsolute(candidate) ? candidate : path.resolve(instance.directory, candidate)
    const guard = isProtectedPath(filepath)
    if (!guard.blocked) continue
    if (guard.type === "system") return yield* Effect.fail(new Error(guard.reason))
    yield* ctx.ask({
      permission: "extension_write",
      patterns: [filepath],
      always: ["*"],
      metadata: { filepath, tool: toolID },
    })
  }
})
