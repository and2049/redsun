import { Plugin } from "@opencode/plugin/tui"
import { createEffect } from "solid-js"
import base from "../theme-v1.json" with { type: "json" }

const skin = (background: string) => ({ ...base, theme: { ...base.theme, background } })

function hex(color: { r: number; g: number; b: number }) {
  return (
    "#" +
    [color.r, color.g, color.b]
      .map((value) =>
        Math.round(value * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  )
}

function Logo(props: { context: Plugin.Context }) {
  const dimensions = props.context.ui.dimensions
  return (
    <box>
      <text>SKIN LOGO {props.context.app.name}</text>
      <text>
        mode {props.context.vim.mode} theme {props.context.themes.current()} bg{" "}
        {hex(props.context.theme.background.default)}
      </text>
      <text>
        dims {dimensions().width}x{dimensions().height}
      </text>
    </box>
  )
}

function Backdrop(props: { context: Plugin.Context; width: number; height: number }) {
  createEffect(() => props.context.themes.select(props.context.vim.mode === "insert" ? "skin" : "skin-warm"))
  return (
    <text>
      backdrop {props.width}x{props.height}
    </text>
  )
}

export default Plugin.define({
  id: "test.skin",
  api: 1,
  setup(context) {
    context.themes.register("skin", skin("#123456"))
    context.themes.register("skin-warm", skin("#654321"))
    context.themes.lock()
    context.themes.select("skin")
    context.ui.slot({ replace: "home.logo", render: () => <Logo context={context} /> })
    context.ui.slot({
      append: "home.backdrop",
      render: (input) => <Backdrop context={context} width={input.width} height={input.height} />,
    })
  },
})
