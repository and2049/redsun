import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { createMemo } from "solid-js"
import { buildSubagentSessionOptions } from "../../input/subagent-session"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()

  return (
    <DialogSelect
      title="Subagent Actions"
      options={[
        {
          title: "Open",
          value: "subagent.view",
          description: "the subagent's session",
          onSelect: (dialog) => {
            route.navigate({
              type: "session",
              sessionID: props.sessionID,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}

export function DialogSubagents(props: { sessionID: string }) {
  const route = useRoute()
  const sync = useSync()
  const options = createMemo((): DialogSelectOption<string>[] =>
    buildSubagentSessionOptions({
      sessions: sync.data.session,
      currentID: props.sessionID,
      permissions: sync.data.permission as any,
      statuses: sync.data.session_status as any,
    }).map((item) => ({
      value: item.id,
      title: item.title,
      description: item.description,
      footer: item.footer,
      onSelect: (dialog) => {
        route.navigate({
          type: "session",
          sessionID: item.id,
        })
        dialog.clear()
      },
    })),
  )

  return <DialogSelect title="Subagent sessions" current={props.sessionID} options={options()} />
}
