import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()
  // The variant picker is the model picker's second step, so it rises from the
  // same edge rather than jumping to the middle of the screen between them.
  dialog.setPlacement("bottom")

  const options = createMemo(() =>
    local.model.variant.list().map((variant) => ({
      value: variant,
      title: variant,
      onSelect: () => {
        dialog.clear()
        local.model.variant.set(variant)
      },
    })),
  )

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant"}
      current={local.model.variant.current()}
      flat={true}
    />
  )
}
