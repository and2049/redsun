import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useLanguage } from "../i18n"

export function DialogVariant(props: {
  title?: string
  variants?: string[]
  selected?: string
  onSelect?: (variant: string) => void
}) {
  const local = useLocal()
  const dialog = useDialog()
  const { t } = useLanguage()
  dialog.setPlacement("bottom")

  const list = createMemo(() => props.variants ?? local.model.variant.list())
  const options = createMemo(() => [
    {
      value: "default",
      title: t("common.default"),
      onSelect: () => {
        dialog.clear()
        if (props.onSelect) props.onSelect("default")
        else local.model.variant.set(undefined)
      },
    },
    ...list()
      .filter((variant) => variant !== "default")
      .map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => {
          dialog.clear()
          if (props.onSelect) props.onSelect(variant)
          else local.model.variant.set(variant)
        },
      })),
  ])

  return (
    <DialogSelect<string>
      options={options()}
      title={props.title ?? t("ui.selectVariant")}
      current={props.selected ?? local.model.variant.current() ?? "default"}
      flat={true}
    />
  )
}
