import { Plugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import { contextUsage } from "../../util/session"
import { useLanguage } from "../../i18n"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function SidebarContext(props: { context: Plugin.Context; sessionID: string }) {
  const { t } = useLanguage()
  const theme = props.context.theme
  const msg = createMemo(() => props.context.data.session.message.list(props.sessionID))
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const cost = createMemo(() => props.context.data.session.cost(props.sessionID))

  const state = createMemo(() =>
    contextUsage(msg(), props.context.data.location.model.list(session()?.location), session()?.revert?.messageID),
  )

  return (
    <Show when={state() || cost() > 0}>
      <box>
        <text fg={theme.text.default}>
          <b>{t("command.category.context")}</b>
        </text>
        <Show when={state()}>
          {(value) => (
            <>
              <text fg={theme.text.subdued}>
                {t("session.usage.tokenCount", { tokens: value().tokens.toLocaleString() })}
              </text>
              <Show when={value().percent !== undefined}>
                <text fg={theme.text.subdued}>{t("activity.used", { percent: value().percent ?? 0 })}</text>
              </Show>
            </>
          )}
        </Show>
        <Show when={cost() > 0}>
          <text fg={theme.text.subdued}>{t("activity.spent", { cost: money.format(cost()) })}</text>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.context",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarContext context={context} sessionID={props.sessionID} />,
    })
  },
})
