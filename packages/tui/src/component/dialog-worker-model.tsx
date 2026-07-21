import { useDialog } from "../ui/dialog"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { DialogModel } from "./dialog-model"

export function needsWorkerModel(agent: string, route: string | undefined) {
  return agent === "compose" && !route
}

export function useWorkerModelDialog() {
  const dialog = useDialog()
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  return () => {
    const fallback = sync.data.agent.find((agent) => agent.name === "worker")?.model
    const current = sync.data.config.task_router?.worker ?? (fallback ? `${fallback.providerID}/${fallback.modelID}` : undefined)
    const [providerID, ...rest] = current?.split("/") ?? []
    dialog.replace(() => (
      <DialogModel
        title="Select worker model (project)"
        current={providerID && rest.length ? { providerID, modelID: rest.join("/") } : undefined}
        onSelect={async (model) => {
          const worker = `${model.providerID}/${model.modelID}`
          await sdk.client.config.update(
            { workspace: project.workspace.current(), config: { task_router: { worker } } },
            { throwOnError: true },
          )
          sync.set("config", {
            ...sync.data.config,
            task_router: { ...sync.data.config.task_router, worker },
          })
        }}
        onError={(error) => toast.error(error)}
      />
    ))
  }
}
