import z from "zod"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"

export const ReloadTool = Tool.define("reload", async () => ({
  description: "Reload the redsun runtime to pick up newly written extensions, tools, or configuration files. Use this after writing new extension files to disk so they become available.",
  parameters: z.object({}),
  async execute(_params, _ctx) {
    ToolRegistry.setPendingReload()
    return {
      title: "Reload queued",
      output: "Runtime reload has been queued and will execute after the current turn completes. All extensions and tools will be re-scanned from disk. New extensions will become available in the next turn.",
      metadata: {},
    }
  },
  promptGuidelines: [
    "Use the reload tool after writing new extension files to disk so they are loaded and available.",
    "Do not reload after every tool registration — only when files on disk change.",
  ],
}))
