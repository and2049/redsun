import { TextAttributes, RGBA } from "@opentui/core"
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

export function Logo() {
  const { theme, terminalDefaultBackground } = useTheme()
  const logoWidth = LOGO[0].length

  const actualBg = () =>
    theme.background.a === 0
      ? (terminalDefaultBackground ?? theme.background)
      : theme.background

  return (
    <box>
      <For each={LOGO}>
        {(line) => {
          const chars = line.split("")
          return (
            <box flexDirection="row">
              <For each={chars}>
                {(char, i) => {
                  const t = () => i() / logoWidth

                  const baseColor = () => {
                    const start = theme.logoGradientStart
                    const end = theme.logoGradientEnd
                    const r = start.r + (end.r - start.r) * t()
                    const g = start.g + (end.g - start.g) * t()
                    const b = start.b + (end.b - start.b) * t()
                    return RGBA.fromInts(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255))
                  }

                  if (char === " ") {
                    return <text selectable={false}> </text>
                  }

                  if (char === "█") {
                    return (
                      <text fg={baseColor()} attributes={TextAttributes.BOLD} selectable={false}>
                        {char}
                      </text>
                    )
                  }

                  const shadowColor = () => {
                    const start = theme.logoGradientStart
                    const end = theme.logoGradientEnd
                    const r = start.r + (end.r - start.r) * t()
                    const g = start.g + (end.g - start.g) * t()
                    const b = start.b + (end.b - start.b) * t()

                    const alpha = 0.4
                    const bg = actualBg()

                    const shadowR = r * alpha + bg.r * (1.0 - alpha)
                    const shadowG = g * alpha + bg.g * (1.0 - alpha)
                    const shadowB = b * alpha + bg.b * (1.0 - alpha)
                    return RGBA.fromInts(
                      Math.round(shadowR * 255),
                      Math.round(shadowG * 255),
                      Math.round(shadowB * 255),
                    )
                  }

                  return (
                    <text fg={shadowColor()} selectable={false}>
                      {char}
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