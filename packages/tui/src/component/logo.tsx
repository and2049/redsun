// REDSUN DENSE: the home-screen wordmark.
//
// A block-ASCII "REDSUN" painted as a horizontal gradient between the theme's
// two logo endpoints. Full blocks take the gradient colour directly; the box
// characters that draw the outline take a 40%-toward-background wash of the same
// colour, which is what gives the letters their bevelled edge.
import { RGBA, TextAttributes } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"

const LOGO = [
  `██╗      ██████╗ ███████╗██████╗ ███████╗██╗   ██╗███╗   ██╗`,
  `╚██╗     ██╔══██╗██╔════╝██╔══██╗██╔════╝██║░░░██║████╗░░██║`,
  ` ╚██╗    ██████╔╝█████╗░░██║░░██║███████╗██║░░░██║██╔██╗░██║`,
  ` ██╔╝    ██╔══██╗██╔══╝░░██║░░██║╚════██║██║░░░██║██║╚██╗██║`,
  `██╔╝     ██║  ██║███████╗██████╔╝███████║╚██████╔╝██║░╚████║`,
  `╚═╝      ╚═╝  ╚═╝╚══════╝╚═════╝ ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝`,
]

const LOGO_WIDTH = LOGO[0]!.length
const SHADOW_ALPHA = 0.4

export function Logo() {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  // Below the wordmark's own width there is nothing to shrink to — the art is
  // fixed — so it gives up its rows rather than wrapping into noise.
  const visible = createMemo(() => dimensions().height >= 12 && dimensions().width >= LOGO_WIDTH)

  const mix = (a: RGBA, b: RGBA, t: number) =>
    RGBA.fromInts(
      Math.round((a.r + (b.r - a.r) * t) * 255),
      Math.round((a.g + (b.g - a.g) * t) * 255),
      Math.round((a.b + (b.b - a.b) * t) * 255),
    )

  return (
    <Show when={visible()}>
      <box>
        <For each={LOGO}>
          {(line) => (
            <box flexDirection="row">
              <For each={Array.from(line)}>
                {(char, index) => {
                  const base = createMemo(() =>
                    mix(theme.logo.gradient.start, theme.logo.gradient.end, index() / LOGO_WIDTH),
                  )
                  if (char === " ") return <text selectable={false}> </text>
                  if (char === "█")
                    return (
                      <text fg={base()} attributes={TextAttributes.BOLD} selectable={false}>
                        {char}
                      </text>
                    )
                  return (
                    <text fg={mix(theme.background.default, base(), SHADOW_ALPHA)} selectable={false}>
                      {char}
                    </text>
                  )
                }}
              </For>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
