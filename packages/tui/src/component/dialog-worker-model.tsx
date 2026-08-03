import { useDialog } from "../ui/dialog"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
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
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  return (route = sync.data.config.task_router?.worker) => {
    const variants = workerModelVariants(route, sync.data.provider)
    if (!route) {
      toast.show({ message: "Select a worker model first", variant: "warning" })
      return
    }
    if (!variants.length) {
      toast.show({ message: "This worker model has no variants", variant: "warning" })
      return
    }
    dialog.replace(() => (
      <DialogVariant
        title="Select worker model variant (project)"
        variants={variants}
        selected={sync.data.config.task_router?.worker_variant ?? "default"}
        onSelect={async (variant) => {
          const worker_variant = variant ?? "default"
          try {
            await sdk.client.config.update(
              { workspace: project.workspace.current(), config: { task_router: { worker_variant } } },
              { throwOnError: true },
            )
            sync.set("config", {
              ...sync.data.config,
              task_router: { ...sync.data.config.task_router, worker_variant },
            })
          } catch (error) {
            toast.error(error)
            throw error
          }
        }}
      />
    ))
  }
}

export function useWorkerModelDialog() {
  const dialog = useDialog()
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const openVariant = useWorkerVariantDialog()

  return () => {
    const fallback = sync.data.agent.find((agent) => agent.name === "worker")?.model
    const current =
      sync.data.config.task_router?.worker ?? (fallback ? `${fallback.providerID}/${fallback.modelID}` : undefined)
    const [providerID, ...rest] = current?.split("/") ?? []
    dialog.replace(() => (
      <DialogModel
        title="Select worker model (project)"
        current={providerID && rest.length ? { providerID, modelID: rest.join("/") } : undefined}
        closeOnSelect={false}
        onSelect={async (model, context) => {
          const worker = `${model.providerID}/${model.modelID}`
          const worker_variant = "default"
          await sdk.client.config.update(
            { workspace: project.workspace.current(), config: { task_router: { worker, worker_variant } } },
            { throwOnError: true },
          )
          sync.set("config", {
            ...sync.data.config,
            task_router: { ...sync.data.config.task_router, worker, worker_variant },
          })
          if (!context.active()) return
          if (workerModelVariants(worker, sync.data.provider).length) openVariant(worker)
          else dialog.clear()
        }}
        onError={(error) => toast.error(error)}
      />
    ))
  }
}
