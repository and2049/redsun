import { RGBA, TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "../context/theme"

const LOGO = [
  `██╗      ██████╗ ███████╗██████╗ ███████╗██╗   ██╗███╗   ██╗`,
  `╚██╗     ██╔══██╗██╔════╝██╔══██╗██╔════╝██║░░░██║████╗░░██║`,
  ` ╚██╗    ██████╔╝█████╗░░██║░░██║███████╗██║░░░██║██╔██╗░██║`,
  ` ██╔╝    ██╔══██╗██╔══╝░░██║░░██║╚════██║██║░░░██║██║╚██╗██║`,
  `██╔╝     ██║  ██║███████╗██████╔╝███████║╚██████╔╝██║░╚████║`,
  `╚═╝      ╚═╝  ╚═╝╚══════╝╚═════╝ ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝`,
]
const GRADIENT_START = RGBA.fromHex("#5476E5")
const GRADIENT_END = RGBA.fromHex("#FF7399")

export function Logo() {
  const { theme } = useTheme()
  const width = LOGO[0].length

  const color = (index: number) => {
    const progress = index / width
    const start = theme.logoGradientStart ?? GRADIENT_START
    const end = theme.logoGradientEnd ?? GRADIENT_END
    return RGBA.fromValues(
      start.r + (end.r - start.r) * progress,
      start.g + (end.g - start.g) * progress,
      start.b + (end.b - start.b) * progress,
      1,
    )
  }

  const shadow = (index: number) => {
    const foreground = color(index)
    return RGBA.fromValues(
      foreground.r * 0.4 + theme.background.r * 0.6,
      foreground.g * 0.4 + theme.background.g * 0.6,
      foreground.b * 0.4 + theme.background.b * 0.6,
      1,
    )
  }

  return (
    <box>
      <For each={LOGO}>
        {(line) => (
          <box flexDirection="row">
            <For each={Array.from(line)}>
              {(char, index) => (
                <text
                  fg={char === "█" ? color(index()) : shadow(index())}
                  attributes={char === "█" ? TextAttributes.BOLD : undefined}
                  selectable={false}
                >
                  {char}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}
