import { createMemo, createSignal, onCleanup } from "solid-js"
import { useConfig } from "../config"
import { useLanguage, type Locale } from "../i18n"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

export function DialogLanguage(props: { onSelect?: () => void; onCancel?: () => void }) {
  const config = useConfig()
  const dialog = useDialog()
  const toast = useToast()
  const { t, locale, languages } = useLanguage()
  const [saving, setSaving] = createSignal(false)
  let closed = false
  onCleanup(() => {
    closed = true
  })
  const done = () => {
    if (!closed) (props.onSelect ?? dialog.clear)()
  }
  const options = createMemo(() =>
    languages().map((language) => ({
      title: language.nativeName,
      value: language.locale,
      description: language.available ? t(language.name) : t("settings.language.unavailable"),
      searchText: `${language.name} ${language.locale} ${language.providers.join(" ")}`,
    })),
  )

  async function select(language: Locale) {
    if (saving()) return
    if (!languages().some((item) => item.locale === language && item.available)) return
    if (language === locale()) {
      done()
      return
    }
    setSaving(true)
    try {
      await config.update((draft) => {
        draft.language = language
      })
      done()
    } catch (error) {
      toast.error(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogSelect
      title={`${t("settings.language.title")} / Language`}
      current={locale()}
      options={options()}
      locked={saving()}
      onCancel={props.onCancel}
      onSelect={(option) => void select(option.value)}
    />
  )
}
