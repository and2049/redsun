import { useDialog } from "../ui/dialog"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { DialogModel } from "./dialog-model"
import type { Provider } from "@opencode-ai/sdk/v2"
import * as Model from "../util/model"
import { DialogVariant } from "./dialog-variant"

export function needsWorkerModel(agent: string, route: string | undefined) {
  return agent === "compose" && !route
}

export function workerModelDisplay(route: string | undefined, providers: Provider[]) {
  if (!route) return
  const { providerID, modelID } = Model.parse(route)
  const provider = providers.find((item) => item.id === providerID)
  return {
    model: provider?.models[modelID]?.name ?? modelID,
    provider: provider?.name ?? providerID,
  }
}

export function workerModelVariants(route: string | undefined, providers: Provider[]) {
  if (!route) return []
  const { providerID, modelID } = Model.parse(route)
  return Object.keys(providers.find((item) => item.id === providerID)?.models[modelID]?.variants ?? {})
}

export function workerVariantDisplay(route: string | undefined, variant: string | undefined, providers: Provider[]) {
  if (!variant || variant === "default") return undefined
  return workerModelVariants(route, providers).includes(variant) ? variant : undefined
}

export function useWorkerVariantDialog() {
  const dialog = useDialog()
  const local = useLocal()
  const sync = useSync()
  const toast = useToast()

  return (route?: string) => {
    const resolved = local.model.worker.current()
    const effective = route ?? (resolved ? `${resolved.providerID}/${resolved.modelID}` : undefined)
    const variants = workerModelVariants(effective, sync.data.provider)
    if (!effective) {
      toast.show({ message: "Select a worker model first", variant: "warning" })
      return
    }
    if (!variants.length) {
      toast.show({ message: "This worker model has no variants", variant: "warning" })
      return
    }
    dialog.replace(() => (
      <DialogVariant
        title="Select worker model variant"
        variants={variants}
        selected={resolved?.variant ?? "default"}
        onSelect={(variant) => {
          local.model.worker.setVariant(variant)
        }}
      />
    ))
  }
}

export function useWorkerModelDialog() {
  const dialog = useDialog()
  const local = useLocal()
  const sync = useSync()
  const toast = useToast()
  const openVariant = useWorkerVariantDialog()

  return () => {
    const current = local.model.worker.current()
    dialog.replace(() => (
      <DialogModel
        title="Select worker model"
        current={current ? { providerID: current.providerID, modelID: current.modelID } : undefined}
        closeOnSelect={false}
        onSelect={(model, context) => {
          local.model.worker.set({ providerID: model.providerID, modelID: model.modelID })
          const worker = `${model.providerID}/${model.modelID}`
          if (!context.active()) return
          if (workerModelVariants(worker, sync.data.provider).length) openVariant(worker)
          else dialog.clear()
        }}
        onError={(error) => toast.error(error)}
      />
    ))
  }
}
