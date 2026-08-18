import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogVariant(props: {
  /** REDSUN: the worker variant picker is this menu pointed at a different sink. */
  title?: string
  variants?: string[]
  selected?: string
  onSelect?: (variant: string) => void
}) {
  const local = useLocal()
  const dialog = useDialog()
  // The variant picker is the model picker's second step, so it rises from the
  // same edge rather than jumping to the middle of the screen between them.
  dialog.setPlacement("bottom")

  const list = createMemo(() => props.variants ?? local.model.variant.list())
  const options = createMemo(() =>
    list().map((variant) => ({
      value: variant,
      title: variant,
      onSelect: () => {
        dialog.clear()
        if (props.onSelect) props.onSelect(variant)
        else local.model.variant.set(variant)
      },
    })),
  )

  return (
    <DialogSelect<string>
      options={options()}
      title={props.title ?? "Select variant"}
      current={props.selected ?? local.model.variant.current()}
      flat={true}
    />
  )
}
