import { createMemo, onCleanup } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogVariant(
  props: {
    title?: string
    variants?: string[]
    selected?: string
    onSelect?: (variant: string | undefined) => void | Promise<void>
  } = {},
) {
  const local = useLocal()
  const dialog = useDialog()
  let active = true
  onCleanup(() => {
    active = false
  })

  const select = async (variant: string | undefined) => {
    try {
      await props.onSelect?.(variant)
    } catch {
      return
    }
    if (!props.onSelect) local.model.variant.set(variant)
    if (active) dialog.clear()
  }

  const options = createMemo(() => {
    return [
      {
        value: "default",
        title: "Default",
        onSelect: () => select(undefined),
      },
      ...(props.variants ?? local.model.variant.list()).map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => select(variant),
      })),
    ]
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={props.title ?? "Select variant"}
      current={props.selected ?? local.model.variant.selected()}
      flat={true}
    />
  )
}
