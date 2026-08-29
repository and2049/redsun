/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { createSignal } from "solid-js"
import { Mount } from "../src/services/update-preflight"

test("hiding the preflight footer leaves a later root mounted on the same renderer intact", async () => {
  const { renderer } = await createTestRenderer({ width: 80, height: 24, useThread: false })
  try {
    const [visible, setVisible] = createSignal(true)
    await render(
      () => (
        <Mount visible={visible}>
          <box id="preflight-footer" height={4} />
        </Mount>
      ),
      renderer,
    )
    await render(() => <box id="tui-root" />, renderer)
    const tui = renderer.root.findDescendantById("tui-root")
    expect(tui).toBeInstanceOf(BoxRenderable)
    expect(renderer.root.findDescendantById("preflight-footer")).toBeInstanceOf(BoxRenderable)

    setVisible(false)
    await new Promise((resolve) => setImmediate(resolve))

    expect(renderer.root.findDescendantById("preflight-footer")).toBeUndefined()
    expect(renderer.root.findDescendantById("tui-root")).toBe(tui)
    expect(tui?.isDestroyed).toBe(false)
  } finally {
    renderer.destroy()
  }
})
