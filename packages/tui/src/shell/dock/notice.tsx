// Dense replacement for the floating `Toast`.
//
// The dock has no room for a bordered panel, so toasts collapse to a single
// dim status line coloured by variant (the --mini `setNotice` pattern). The
// toast store, timers and `useToast()` API are shared with classic.
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useToast } from "../../ui/toast"
import * as Locale from "../../util/locale"

const SYMBOL = {
  info: "·",
  success: "✓",
  warning: "⚠",
  error: "⨯",
} as const

export function Notice(props: { width?: number }) {
  const toast = useToast()
  const { theme } = useTheme()

  const color = createMemo(() => {
    const current = toast.currentToast
    if (!current) return theme.textMuted
    if (current.variant === "success") return theme.success
    if (current.variant === "warning") return theme.warning
    if (current.variant === "error") return theme.error
    return theme.accent
  })

  const text = createMemo(() => {
    const current = toast.currentToast
    if (!current) return ""
    const message = [current.title, current.message].filter(Boolean).join(": ")
    return `${SYMBOL[current.variant]} ${Locale.truncate(message, Math.max(8, (props.width ?? 80) - 2))}`
  })

  return (
    <Show when={toast.currentToast}>
      <box height={1} flexDirection="row">
        <text fg={color()} wrapMode="none" truncate>
          {text()}
        </text>
      </box>
    </Show>
  )
}
