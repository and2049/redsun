import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"

const LOGO = [
  `██████╗ ███████╗██████╗ ███████╗██╗   ██╗███╗   ██╗`,
  `██╔══██╗██╔════╝██╔══██╗██╔════╝██║░░░██║████╗  ██║`,
  `██████╔╝█████╗  ██║░░██║███████╗██║░░░██║██╔██╗ ██║`,
  `██╔══██╗██╔══╝  ██║░░██║╚════██║██║░░░██║██║╚██╗██║`,
  `██║  ██║███████╗██████╔╝███████║╚██████╔╝██║ ╚████║`,
  `╚═╝  ╚═╝╚══════╝╚═════╝ ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝`,
]

export function Logo() {
  const { theme } = useTheme()
  return (
    <box>
      <For each={LOGO}>
        {(line) => {
          const chunks = line.match(/(█+|[^█]+)/g) || []
          return (
            <box flexDirection="row">
              <For each={chunks}>
                {(chunk) => {
                  const isSolid = chunk.includes("█")
                  return (
                    <text
                      fg={isSolid ? theme.text : theme.textMuted}
                      attributes={isSolid ? TextAttributes.BOLD : undefined}
                      selectable={false}
                    >
                      {chunk}
                    </text>
                  )
                }}
              </For>
            </box>
          )
        }}
      </For>
    </box>
  )
}
