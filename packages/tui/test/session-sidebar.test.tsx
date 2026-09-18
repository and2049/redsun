import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import type { Config } from "../src/config"
import { SESSION_SIDEBAR_WIDTH } from "../src/ui/layout"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

test.each([140, 100])("session sidebar renders on the right and toggles at %s columns", async (width) => {
  await using state = await tmpdir()
  let config: Config.Info = {
    animations: false,
    session: { sidebar: "auto" },
    keybinds: { "session.sidebar.toggle": "f6" },
  }
  const title = "Sidebar regression fixture"
  await using app = await createAppFixture({
    width,
    state: state.path,
    args: { sessionID: "ses_sidebar" },
    configService: {
      get: async () => config,
      update: async (update) => {
        const draft = structuredClone(config)
        update(draft)
        return (config = draft)
      },
    },
    fetch: (url) => {
      if (url.pathname === "/api/session/ses_sidebar")
        return json({
          data: {
            id: "ses_sidebar",
            projectID: "project",
            title,
            location: { directory },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      if (url.pathname === "/api/session/ses_sidebar/message") return json({ data: [], cursor: {} })
      if (url.pathname === "/api/session/ses_sidebar/inbox" || url.pathname === "/api/session/ses_sidebar/permission")
        return json({ data: [] })
      return undefined
    },
  })
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const editor = app.renderer.currentFocusedEditor!
  await app.waitForVisualIdle()
  if (width <= 120) {
    expect(app.captureCharFrame()).not.toContain(title)
    app.mockInput.pressKey("F6")
  }
  const frame = await app.waitForFrame((frame) => frame.includes(title))
  expect(
    frame
      .split("\n")
      .find((line) => line.includes(title))!
      .indexOf(title),
  ).toBe(width - SESSION_SIDEBAR_WIDTH + 2)
  const sidebarWidth = editor.width
  app.mockInput.pressKey("F6")
  await app.waitForFrame((frame) => !frame.includes(title))
  await app.waitForVisualIdle()
  expect(config.session?.sidebar).toBe("hide")
  expect(editor.width - sidebarWidth).toBe(width > 120 ? SESSION_SIDEBAR_WIDTH : 0)
  app.mockInput.pressKey("F6")
  await app.waitForFrame((frame) => frame.includes(title))
  expect(config.session?.sidebar).toBe("auto")
})
