import { useDialog } from "../ui/dialog"
import { useLocal } from "../context/local"
import { useClient } from "../context/client"
import type { FormWithLocation } from "../context/data"
import { DialogModel } from "./dialog-model"
import { DialogVariant } from "./dialog-variant"
import { formRequestOptions, isFormAnswerField } from "../util/form"

export const WORKER_MODEL_KEY = "redsun.worker-model"

export function isWorkerModelForm(form: FormWithLocation) {
  return form.metadata?.["kind"] === "worker-model"
}

export function workerModelRef(model: { providerID: string; modelID: string; variant?: string }) {
  return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
}

export function parseWorkerModelRef(value: string) {
  const slash = value.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = value.slice(0, slash)
  const rest = value.slice(slash + 1)
  const hash = rest.lastIndexOf("#")
  const modelID = hash > 0 ? rest.slice(0, hash) : rest
  const variant = hash > 0 ? rest.slice(hash + 1) : undefined
  if (modelID.length === 0) return undefined
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

export function useWorkerVariantDialog() {
  const dialog = useDialog()
  const local = useLocal()

  return () => {
    const current = local.model.worker.current()
    const variants = local.model.worker.variants()
    if (!current || variants.length === 0) return false
    dialog.replace(() => (
      <DialogVariant
        title="Select worker model variant"
        variants={variants}
        selected={current.variant}
        onSelect={(variant) => local.model.worker.setVariant(variant)}
      />
    ))
    return true
  }
}

export function useWorkerModelDialog() {
  const dialog = useDialog()
  const local = useLocal()
  const client = useClient()
  const openVariant = useWorkerVariantDialog()

  return (form?: FormWithLocation) => {
    const current = local.model.worker.current()
    let answered = false

    const answer = (ref: string) => {
      if (!form || answered) return
      const field = form.fields.find(isFormAnswerField)
      if (!field) return
      answered = true
      void client.api.form
        .reply({ sessionID: form.sessionID, formID: form.id, answer: { [field.key]: ref } }, formRequestOptions(form))
        .catch(() => {})
    }

    dialog.replace(
      () => (
        <DialogModel
          title="Select worker model"
          current={current ? { providerID: current.providerID, modelID: current.modelID } : undefined}
          closeOnSelect={false}
          onSelect={(model) => {
            local.model.worker.set(model)
            answer(workerModelRef(model))
            if (!openVariant()) dialog.clear()
          }}
        />
      ),
      () => {
        if (!form || answered) return
        void client.api.form
          .cancel({ sessionID: form.sessionID, formID: form.id }, formRequestOptions(form))
          .catch(() => {})
      },
      form ? { key: `worker-model:${form.id}` } : undefined,
    )
  }
}
