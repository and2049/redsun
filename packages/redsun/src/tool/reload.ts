import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"

export const ReloadTool = Tool.define("reload", async () => ({
  description: "Reload the redsun runtime to pick up newly written extensions, tools, or configuration files. Use this after writing new extension files to disk so they become available.",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await Instance.dispose()
    return {
      title: "Runtime reloaded",
      output: "The redsun runtime has been reloaded. All extensions and tools have been re-scanned from disk. New extensions are now available.",
      metadata: {},
    }
  },
  promptGuidelines: [
    "Use the reload tool after writing new extension files to disk so they are loaded and available.",
    "Do not reload after every tool registration — only when files on disk change.",
  ],
}))
