import type { Tool } from "../tool/tool"
import type { Extension } from "./types"

export namespace ExtensionWrapper {
  export function wrapTool(tool: Tool.Info, source: Extension.SourceInfo): Tool.Info {
    return {
      ...tool,
      id: tool.id,
    }
  }
}
