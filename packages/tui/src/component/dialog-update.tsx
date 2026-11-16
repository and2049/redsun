import { createEffect, createMemo, createResource, createSignal, Match, onCleanup, Show, Switch } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import type { UpdateState } from "../context/update-notification"
import { DialogButtons, DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { errorMessage } from "../util/error"
import { Spinner } from "./spinner"
import { useLanguage } from "../i18n"

export function DialogUpdate(props: {
  check?: (signal: AbortSignal) => Promise<string | undefined>
  state: () => UpdateState | undefined
  skip: () => void
  install: () => Promise<void>
  restart: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const { t } = useLanguage()
  const [error, setError] = createSignal<string>()
  const [active, setActive] = createSignal(0)
  const controller = new AbortController()
  onCleanup(() => controller.abort())

  dialog.setCentered(true)

  const [check] = createResource(
    () => props.check,
    (check) =>
      check(controller.signal).catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error))
        return undefined
      }),
  )
  const state = createMemo(() => {
    const message = error()
    if (message) return { type: "check-failed" as const, message }
    const current = props.state()
    if (current?.type === "installing") return current
    if (check.loading) return { type: "checking" as const }
    const unavailable = check()
    if (unavailable) return { type: "unavailable" as const, message: unavailable }
    return current ?? { type: "current" as const }
  })
  const buttons = createMemo(() => {
    const type = state().type
    if (type === "installing") return []
    const confirm =
      type === "available"
        ? { label: t("titlebar.update"), run: props.install }
        : type === "installed"
          ? { label: t("error.page.action.restart"), run: props.restart }
          : undefined
    return [
      {
        label: t("ui.skip"),
        run: () => {
          props.skip()
          dialog.clear()
        },
      },
      ...(confirm ? [confirm] : []),
    ]
  })

  createEffect(() => setActive(Math.max(0, buttons().length - 1)))

  const move = (step: number) => {
    const count = buttons().length
    if (count) setActive((value) => (value + step + count) % count)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: t("ui.confirmUpdateAction"),
        group: "Dialog",
        run: () => void buttons()[active()]?.run(),
      },
      { bind: "left", title: t("ui.previousUpdateAction"), group: "Dialog", run: () => move(-1) },
      { bind: "shift+tab", title: t("ui.previousUpdateAction"), group: "Dialog", run: () => move(-1) },
      { bind: "right", title: t("ui.nextUpdateAction"), group: "Dialog", run: () => move(1) },
      { bind: "tab", title: t("ui.nextUpdateAction"), group: "Dialog", run: () => move(1) },
    ],
  }))

  return (
    <DialogLayout
      header={
        <DialogHeader
          title={
            state().type === "available" || state().type === "installing" || state().type === "failed"
              ? t("toast.update.title")
              : t("titlebar.update")
          }
        />
      }
      buttons={
        <Show when={buttons().length > 0}>
          <DialogButtons
            buttons={buttons().map((button) => ({ label: button.label, run: () => void button.run() }))}
            active={active()}
            onActive={setActive}
          />
        </Show>
      }
    >
      <Show when={state()} keyed>
        {(current) => (
          <Switch>
            <Match when={current.type === "checking"}>
              <Spinner shimmer={theme.text.base}>{t("ui.checkingForUpdates")}</Spinner>
            </Match>
            <Match when={current.type === "available"}>
              <text fg={theme.text.muted}>{t("ui.anUpdateIsAvailableAfterInstallingYouLl")}</text>
            </Match>
            <Match when={current.type === "installing"}>
              <Spinner shimmer={theme.text.base}>
                {current.type === "installing" ? t("ui.installingRedsun", { version: current.version }) : ""}
              </Spinner>
            </Match>
            <Match when={current.type === "installed"}>
              <text fg={theme.text.muted} wrapMode="word">
                {t("ui.updateSuccessfulARestartIsRequiredAnyActive")}
              </text>
            </Match>
            <Match when={current.type === "current"}>
              <text fg={theme.text.muted}>{t("ui.redsunIsAlreadyUpToDate")}</text>
            </Match>
            <Match when={current.type === "unavailable"}>
              <text fg={theme.text.muted} wrapMode="word">
                {current.type === "unavailable" ? current.message : ""}
              </text>
            </Match>
            <Match when={current.type === "failed" || current.type === "check-failed"}>
              <text fg={theme.text.feedback.error.base}>
                {current.type === "failed" || current.type === "check-failed" ? current.message : ""}
              </text>
            </Match>
          </Switch>
        )}
      </Show>
    </DialogLayout>
  )
}
