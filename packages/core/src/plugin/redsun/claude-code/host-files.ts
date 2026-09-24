export * as ClaudeCodeHostFiles from "./host-files.js"

import path from "node:path"
import { RedsunContextOptimizer } from "../context-optimizer.js"
import { RedsunProjectMemory } from "../project-memory.js"
import type { ClaudeCodeContext } from "./context.js"

/**
 * Canonical instruction files as the delegated CLI receives them: each bounded
 * to the configured instruction size, and project memory carrying its
 * maintenance policy, which the API path adds as a separate system part.
 */
export const deliver = (
  files: readonly ClaudeCodeContext.File[],
  input: { readonly project: string; readonly maxChars: number },
): ClaudeCodeContext.File[] => {
  const memory = path.join(input.project, RedsunProjectMemory.RELATIVE_PATH)
  return files.map((file) => {
    const content = RedsunContextOptimizer.boundInstructionContent(file.path, file.content, input.maxChars)
    return {
      path: file.path,
      content: file.path === memory ? `${RedsunProjectMemory.POLICY}\n\n${content}` : content,
    }
  })
}
