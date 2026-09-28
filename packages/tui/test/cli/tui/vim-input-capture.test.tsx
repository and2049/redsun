/** @jsxImportSource @opentui/solid */
import type { PermissionRequest } from "@opencode/client"
import { testRender, type JSX } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData, type FormWithLocation } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider } from "../../../src/context/location"
import { ThemeProvider } from "../../../src/context/theme"
import { useVim, VimKeyHandler, VimProvider } from "../../../src/context/vim"
import { FormPrompt } from "../../../src/routes/session/form"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function mountDock(root: string, render: () => JSX.Element) {
  const dispatched: string[] = []
  const ready = Promise.withResolvers<void>()
  let vim!: ReturnType<typeof useVim>
  const transport = createFetch((url) => {
    if (url.pathname === "/api/session/ses_vim")
      return json({
        data: {
          id: "ses_vim",
          parentID: "ses_parent",
          title: "Vim session",
          projectID: "proj_test",
          location: { directory: root },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
  }, createEventStream())

  function Dock() {
    const data = useData()
    vim = useVim()
    vim.setMode("normal")
    Keymap.createLayer(() => ({
      mode: "global",
      commands: ["session.list", "session.new"].map((id) => ({
        id,
        title: id,
        run: () => void dispatched.push(id),
      })),
    }))
    onMount(() => void data.session.sync("ses_vim").then(ready.resolve, ready.reject))
    return <box>{render()}</box>
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <Keymap.Provider>
            <ClientProvider api={createApi(transport.fetch)}>
              <DataProvider directory={root}>
                <LocationProvider>
                  <ThemeProvider source={emptyThemeSource}>
                    <ToastProvider>
                      <DialogProvider>
                        <VimProvider>
                          <VimKeyHandler>
                            <Dock />
                          </VimKeyHandler>
                        </VimProvider>
                      </DialogProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 90, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  await ready.promise
  await app.renderOnce()
  return { app, dispatched, vim }
}

function form(fields: FormWithLocation["fields"]): FormWithLocation {
  return { id: "frm_vim", sessionID: "ses_vim", title: "Vim form", fields }
}

test("an open-ended form keeps normal-mode letters as answer text", async () => {
  await using tmp = await tmpdir()
  const dock = await mountDock(tmp.path, () => <FormPrompt form={form([{ key: "notes", type: "string" }])} />)
  try {
    await dock.app.mockInput.typeText("lin")
    dock.app.mockInput.pressKey("x", { ctrl: true })
    await dock.app.renderOnce()
    expect(dock.app.renderer.currentFocusedEditor?.plainText).toBe("lin")
    expect(dock.dispatched).toEqual([])
    expect(dock.vim.mode).toBe("normal")
    expect(dock.vim.tempRemaining()).toBeNull()
  } finally {
    dock.app.renderer.destroy()
  }
})

test("an option form does not run global normal-mode letter commands", async () => {
  await using tmp = await tmpdir()
  const dock = await mountDock(tmp.path, () => (
    <FormPrompt form={form([{ key: "target", type: "string", options: [{ value: "staging", label: "Staging" }] }])} />
  ))
  try {
    dock.app.mockInput.pressKey("n")
    dock.app.mockInput.pressKey("i")
    await dock.app.renderOnce()
    expect(dock.dispatched).toEqual([])
    expect(dock.vim.mode).toBe("normal")
  } finally {
    dock.app.renderer.destroy()
  }
})

test("a closed form hands normal-mode letters back to vim", async () => {
  await using tmp = await tmpdir()
  const dock = await mountDock(tmp.path, () => <text>empty dock</text>)
  try {
    dock.app.mockInput.pressKey("l")
    expect(dock.dispatched).toEqual(["session.list"])
  } finally {
    dock.app.renderer.destroy()
  }
})

test("permission rejection text keeps normal-mode letters as the message", async () => {
  await using tmp = await tmpdir()
  const request = {
    id: "per_vim",
    sessionID: "ses_vim",
    action: "shell",
    resources: ["echo vim"],
  } satisfies PermissionRequest
  const dock = await mountDock(tmp.path, () => <PermissionPrompt request={request} />)
  try {
    dock.app.mockInput.pressEscape()
    await dock.app.waitForFrame((frame) => frame.includes("Reject permission"))
    await dock.app.mockInput.typeText("new")
    await dock.app.renderOnce()
    expect(dock.app.renderer.currentFocusedEditor?.plainText).toBe("new")
    expect(dock.dispatched).toEqual([])
    expect(dock.vim.mode).toBe("normal")
  } finally {
    dock.app.renderer.destroy()
  }
})
