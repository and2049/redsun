import { createEffect, createMemo } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useLocal } from "../context/local"
import { useClient } from "../context/client"
import type { FormWithLocation } from "../context/data"
import { DialogModel } from "./dialog-model"
import { DialogVariant } from "./dialog-variant"
import { formRequestOptions, isFormAnswerField } from "../util/form"
import { useLanguage } from "../i18n"
import { workerModelRef } from "../util/worker-model"

export function isWorkerModelForm(form: FormWithLocation) {
  return form.metadata?.["kind"] === "worker-model"
}

export function useWorkerVariantDialog() {
  const dialog = useDialog()
  const local = useLocal()
  const { t } = useLanguage()

  return () => {
    const current = local.model.worker.current()
    const variants = local.model.worker.variants()
    if (!current || variants.length === 0) return false
    dialog.replace(() => (
      <DialogVariant
        title={t("ui.selectWorkerModelVariant")}
        variants={variants}
        selected={current.variant}
        // Bound to the model the list opened for, not whatever the session shows by then.
        onSelect={(variant) => local.model.worker.set({ ...current, variant })}
      />
    ))
    return true
  }
}

export function useWorkerModelDialog() {
  const dialog = useDialog()
  const local = useLocal()
  const client = useClient()
  const toast = useToast()
  const openVariant = useWorkerVariantDialog()
  const { t } = useLanguage()

  return (form?: FormWithLocation) => {
    const current = local.model.worker.current()
    let answered = false
    let handedOff = false

    const answer = (ref: string) => {
      if (!form || answered) return
      const field = form.fields.find(isFormAnswerField)
      if (!field) return
      answered = true
      void client.api.session.form
        .reply({ sessionID: form.sessionID, formID: form.id, answer: { [field.key]: ref } }, formRequestOptions(form))
        .catch((error: unknown) => toast.error(error))
    }

    // A form answers for its own session (possibly a child of the one on screen): the server
    // stores the reply, so this only remembers the TUI default and settles the variant first.
    const answerForm = (form: FormWithLocation, model: { providerID: string; modelID: string }) => {
      local.model.worker.remember(model)
      const variants = local.model.worker.variants(model)
      if (variants.length === 0) {
        answer(workerModelRef(model))
        dialog.clear()
        return
      }
      let picked = false
      handedOff = true
      dialog.replace(
        () => (
          <DialogVariant
            title={t("ui.selectWorkerModelVariant")}
            variants={variants}
            onSelect={(variant) => {
              picked = true
              const chosen = { ...model, ...(variant === "default" ? {} : { variant }) }
              local.model.worker.remember(chosen)
              answer(workerModelRef(chosen))
            }}
          />
        ),
        // Closing the variant list keeps the model; DialogVariant closes before it reports a pick.
        () =>
          queueMicrotask(() => {
            if (!picked) answer(workerModelRef(model))
          }),
        { key: `worker-model:${form.id}` },
      )
    }

    dialog.replace(
      () => (
        <DialogModel
          title={t("ui.selectWorkerModel")}
          current={current ? { providerID: current.providerID, modelID: current.modelID } : undefined}
          closeOnSelect={false}
          onSelect={(model) => {
            if (form) return answerForm(form, model)
            local.model.worker.set(model)
            if (!openVariant()) dialog.clear()
          }}
        />
      ),
      () => {
        if (!form || answered || handedOff) return
        void client.api.session.form
          .cancel({ sessionID: form.sessionID, formID: form.id }, formRequestOptions(form))
          .catch(() => {})
      },
      form ? { key: `worker-model:${form.id}` } : undefined,
    )
  }
}

/**
 * The session's forms without its worker-model picker, which opens as the model dialog instead
 * of docking; it closes again once the server settles the form.
 */
export function useWorkerModelForms(forms: () => readonly FormWithLocation[]) {
  const dialog = useDialog()
  const openWorkerModel = useWorkerModelDialog()
  const picker = createMemo(() => forms().find(isWorkerModelForm))
  createEffect(() => {
    const form = picker()
    if (!form) {
      if (typeof dialog.key === "string" && dialog.key.startsWith("worker-model:")) dialog.clear()
      return
    }
    if (dialog.key === `worker-model:${form.id}`) return
    openWorkerModel(form)
  })
  return createMemo(() => forms().filter((form) => !isWorkerModelForm(form)))
}
