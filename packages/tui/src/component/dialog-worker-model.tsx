// REDSUN: the worker model picker, wearing the model menu's clothes.
//
// The worker override is session state the plugin owns, and a plugin can add
// neither an HTTP nor a KV route, so the only way to set it is to answer the
// form the `worker_model` tool raises. That form would otherwise render as the
// generic dock form — a flat list of every model on every provider, in a
// surface that looks nothing like `/models` even though it is the same choice.
//
// So the form is answered from here instead: the same bottom-anchored menu,
// the same providers collapsed behind one row each. What is picked is still a
// form answer; only the shape of the asking changed.
import { createMemo, createSignal } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useClient } from "../context/client"
import { useData, type FormWithLocation } from "../context/data"
import { useLocation } from "../context/location"
import { formRequestOptions, isFormAnswerField } from "../util/form"
import { groupByProvider, providerOfValue, providerRowDescription, providerRowTitle } from "../util/provider-menu"

/** The metadata key the `worker_model` tool stamps on its form. */
export const WORKER_MODEL_FORM = "worker-model"

export function isWorkerModelForm(form: FormWithLocation) {
  return form.metadata?.["kind"] === WORKER_MODEL_FORM
}

type Choice = { value: string; label: string; description?: string }

export function DialogWorkerModel(props: { form: FormWithLocation; onReplied?: () => void }) {
  const dialog = useDialog()
  const client = useClient()
  const data = useData()
  const location = useLocation()
  dialog.setPlacement("bottom")
  const [expanded, setExpanded] = createSignal(new Set<string>())

  function toggleProvider(providerID: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(providerID)) next.delete(providerID)
      else next.add(providerID)
      return next
    })
  }

  const field = createMemo(() => {
    const item = props.form.fields.find(isFormAnswerField)
    if (!item || item.type !== "string" || !item.options) return undefined
    return { key: item.key, choices: item.options as Choice[] }
  })

  const providerNames = createMemo(
    () => new Map((data.location.provider.list(location.ref) ?? []).map((item) => [item.id, item.name])),
  )

  const options = createMemo(() => {
    const current = field()
    if (!current) return []

    // Anything that is not `provider/model` is an instruction rather than a
    // model -- "use the configured default" is the one the tool sends -- and it
    // belongs under the sections, not inside one.
    const loose = current.choices.filter((choice) => providerOfValue(choice.value) === undefined)
    const groups = groupByProvider(
      current.choices.filter((choice) => providerOfValue(choice.value) !== undefined),
      (choice) => providerOfValue(choice.value)!,
    )

    const sections = Array.from(groups, ([providerID, items]) => {
      const open = expanded().has(providerID)
      return [
        {
          value: `provider:${providerID}`,
          title: providerRowTitle(providerNames().get(providerID) ?? providerID, open),
          description: providerRowDescription(items.length),
          category: "Providers",
          onSelect: () => toggleProvider(providerID),
        },
        ...(open
          ? items.map((choice) => ({
              value: choice.value,
              title: `  ${choice.label}`,
              category: "Providers",
              onSelect: () => reply(choice.value),
            }))
          : []),
      ]
    }).flat()

    return [
      ...sections,
      ...loose.map((choice) => ({
        value: choice.value,
        title: choice.label,
        description: choice.description,
        category: "Session",
        onSelect: () => reply(choice.value),
      })),
    ]
  })

  function reply(value: string) {
    const current = field()
    if (!current) return
    props.onReplied?.()
    void client.api.form.reply(
      { sessionID: props.form.sessionID, formID: props.form.id, answer: { [current.key]: value } },
      formRequestOptions(props.form),
    )
    dialog.clear()
  }

  return <DialogSelect<string> options={options()} title="Worker model" flat={true} />
}
