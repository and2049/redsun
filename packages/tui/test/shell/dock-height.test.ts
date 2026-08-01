import { expect, test } from "bun:test"
import {
  DOCK_AUTOCOMPLETE_ROWS,
  DOCK_BASE_ROWS,
  DOCK_COMMAND_ROWS,
  DOCK_PROMPT_ROWS,
  DOCK_ROWS,
  DOCK_TALL_ROWS,
  dockRows,
  dockView,
} from "../../src/shell/dock/height"

test("the prompt view is compact and grows with the live tail and notices", () => {
  expect(dockRows({ view: "prompt", viewport: 50 })).toBe(DOCK_ROWS)
  expect(dockRows({ view: "prompt", viewport: 50, tail: 3 })).toBe(DOCK_ROWS + 3)
  expect(dockRows({ view: "prompt", viewport: 50, tail: 2, notice: true })).toBe(DOCK_ROWS + 3)
})

test("the dock grows with a multi-line draft", () => {
  expect(dockRows({ view: "prompt", viewport: 50, promptRows: 1 })).toBe(DOCK_ROWS)
  expect(dockRows({ view: "prompt", viewport: 50, promptRows: 5 })).toBe(DOCK_ROWS + 4)
  // A draft under an open picker keeps its rows too.
  expect(dockRows({ view: "dialog", viewport: 50, selectRows: 3, promptRows: 3 })).toBe(
    DOCK_BASE_ROWS + DOCK_PROMPT_ROWS + 2 + 3,
  )
})

test("the vim command bar reserves suggestion rows while it is open", () => {
  expect(dockRows({ view: "prompt", viewport: 50, commandBar: true })).toBe(DOCK_ROWS + DOCK_COMMAND_ROWS)
})

test("an inline select sizes the dock to exactly the rows it asked for", () => {
  // The prompt stays mounted under an open picker, so its rows stay reserved.
  expect(dockRows({ view: "dialog", viewport: 50, selectRows: 5 })).toBe(DOCK_BASE_ROWS + DOCK_PROMPT_ROWS + 5)
  expect(dockRows({ view: "dialog", viewport: 50, selectRows: 11, tail: 1 })).toBe(
    DOCK_BASE_ROWS + DOCK_PROMPT_ROWS + 12,
  )
  expect(dockRows({ view: "dialog", viewport: 50, selectRows: 1 })).toBe(DOCK_ROWS + 1)
  // A permission behind the picker hides the prompt and frees its rows.
  expect(dockRows({ view: "dialog", viewport: 50, selectRows: 5, prompt: false })).toBe(DOCK_BASE_ROWS + 5)
})

test("dialogs that are not select-based fall back to the tall dock", () => {
  expect(dockRows({ view: "dialog", viewport: 50 })).toBe(DOCK_TALL_ROWS + 5)
  expect(dockRows({ view: "dialog", viewport: 20 })).toBe(DOCK_TALL_ROWS)
})

test("a non-select dialog gets room in proportion to the size it asked for", () => {
  // Diff viewer and the timeline ask for "large"; the plugin browser and
  // move-session ask for "xlarge" and take the whole viewport.
  expect(dockRows({ view: "dialog", viewport: 40, dialogSize: "medium" })).toBe(20)
  expect(dockRows({ view: "dialog", viewport: 40, dialogSize: "large" })).toBe(30)
  expect(dockRows({ view: "dialog", viewport: 40, dialogSize: "xlarge" })).toBe(40)
  // The size only matters when no inline select declared its own rows.
  expect(dockRows({ view: "dialog", viewport: 40, dialogSize: "xlarge", selectRows: 5 })).toBe(
    DOCK_BASE_ROWS + DOCK_PROMPT_ROWS + 5,
  )
})

test("queued prompts and the subagent strip each take a row", () => {
  expect(dockRows({ view: "prompt", viewport: 50, queued: 2 })).toBe(DOCK_ROWS + 2)
  expect(dockRows({ view: "prompt", viewport: 50, subagent: true })).toBe(DOCK_ROWS + 1)
  expect(dockRows({ view: "prompt", viewport: 50, queued: 1, subagent: true, tail: 2, notice: true })).toBe(
    DOCK_ROWS + 5,
  )
})

test("permission and question prompts always take the tall dock", () => {
  expect(dockRows({ view: "permission", viewport: 60 })).toBe(30)
  expect(dockRows({ view: "question", viewport: 60, selectRows: 3 })).toBe(30)
})

test("the prompt completion popup gets its own reserved rows", () => {
  expect(dockRows({ view: "prompt", viewport: 50, autocomplete: true })).toBe(DOCK_ROWS + DOCK_AUTOCOMPLETE_ROWS)
  // A picker owns the keyboard, so the prompt's popup reservation does not apply.
  expect(dockRows({ view: "dialog", viewport: 50, selectRows: 3, autocomplete: true })).toBe(
    DOCK_BASE_ROWS + DOCK_PROMPT_ROWS + 3,
  )
})

test("a permission arriving mid-picker queues behind the open dialog", () => {
  expect(dockView({ dialogs: 1, permissions: 1, questions: 0 })).toBe("dialog")
  // …and takes over once the picker closes.
  expect(dockView({ dialogs: 0, permissions: 1, questions: 1 })).toBe("permission")
  expect(dockView({ dialogs: 0, permissions: 0, questions: 1 })).toBe("question")
  expect(dockView({ dialogs: 0, permissions: 0, questions: 0 })).toBe("prompt")
})

test("rows never exceed the viewport or drop below one", () => {
  expect(dockRows({ view: "prompt", viewport: 4 })).toBe(4)
  expect(dockRows({ view: "permission", viewport: 6 })).toBe(6)
  expect(dockRows({ view: "prompt", viewport: 0 })).toBe(1)
})
