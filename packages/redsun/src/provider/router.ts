import { Config } from "../config/config"
import { Provider } from "./provider"
import { Log } from "../util/log"

const log = Log.create({ service: "task-router" })

export type TaskSlot = "compact" | "summary" | "title" | "explore"

export async function resolveTaskModel(
  slot: TaskSlot,
  fallback: () => Promise<Provider.Model | undefined>,
): Promise<Provider.Model | undefined> {
  const cfg = await Config.get()
  const routed = cfg.task_router?.[slot]
  if (routed) {
    try {
      const parsed = Provider.parseModel(routed)
      return await Provider.getModel(parsed.providerID, parsed.modelID)
    } catch {
      log.warn("unknown model in task_router", { slot, model: routed })
    }
  }
  return fallback()
}
