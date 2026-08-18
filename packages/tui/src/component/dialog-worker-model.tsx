// REDSUN: picking the model compose delegates to.
//
// It is the model menu pointed at a different sink -- same bottom-anchored
// list, same providers collapsed behind one row -- because it is the same kind
// of choice and should not have to be learned twice.
//
// Two things open it. `worker.model` opens it directly, which is the ordinary
// way. The `worker_model` tool opens it too, by raising a form when a worker
// refuses for lack of a model; answering that form is what makes the choice
// take effect for the rest of the turn already running, since the TUI's own
// copy only reaches the backend on the next prompt.
import { useDialog } from "../ui/dialog"
import { useLocal } from "../context/local"
import { useClient } from "../context/client"
import type { FormWithLocation } from "../context/data"
import { DialogModel } from "./dialog-model"
import { DialogVariant } from "./dialog-variant"
import { formRequestOptions, isFormAnswerField } from "../util/form"

/** The metadata key the tool stamps on its form, and the prompt on its message. */
export const WORKER_MODEL_KEY = "redsun.worker-model"

export function isWorkerModelForm(form: FormWithLocation) {
  return form.metadata?.["kind"] === "worker-model"
}

/** `provider/model#variant`, the shape the backend parses. */
export function workerModelRef(model: { providerID: string; modelID: string; variant?: string }) {
  return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
}

/**
 * The inverse of `workerModelRef`.
 *
 * Only the first slash separates the provider, because model ids carry slashes
 * of their own, and only a trailing `#` marks the variant.
 */
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

  /**
   * @param form the pending `worker_model` form, when the tool is what asked.
   *   Answering it applies the choice inside the turn already running.
   */
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
            // The variant is a second step; the backend picks it up from the
            // next prompt, since the form only carries the model.
            if (!openVariant()) dialog.clear()
          }}
        />
      ),
      () => {
        // Escaping withdraws the tool's ask. Without that the tool waits forever
        // on a form with nothing left on screen to answer it.
        if (!form || answered) return
        void client.api.form
          .cancel({ sessionID: form.sessionID, formID: form.id }, formRequestOptions(form))
          .catch(() => {})
      },
      form ? { key: `worker-model:${form.id}` } : undefined,
    )
  }
}
