import { expect, test } from "bun:test"
import {
  DOCK_BASE_ROWS,
  DOCK_COMMAND_ROWS,
  DOCK_PROMPT_ROWS,
  DOCK_ROWS,
  DOCK_TALL_ROWS,
  dockRows,
} from "../../src/shell/dock/height"

test("the prompt view is compact and grows with the live tail and notices", () => {
  expect(dockRows({ view: "prompt", viewport: 50 })).toBe(DOCK_ROWS)
  expect(dockRows({ view: "prompt", viewport: 50, tail: 3 })).toBe(DOCK_ROWS + 3)
  expect(dockRows({ view: "prompt", viewport: 50, tail: 2, notice: true })).toBe(DOCK_ROWS + 3)
})

test("the vim command bar reserves suggestion rows while it is open", () => {
  expect(dockRows({ view: "prompt", viewport: 50, commandBar: true })).toBe(DOCK_ROWS + DOCK_COMMAND_ROWS)
})

test("an inline select sizes the dock to exactly the rows it asked for", () => {
  expect(dockRows({ view: "dialog", viewport: 50, selectRows: 5 })).toBe(DOCK_BASE_ROWS + 5)
  expect(dockRows({ view: "dialog", viewport: 50, selectRows: 11, tail: 1 })).toBe(DOCK_BASE_ROWS + 12)
  // The prompt is hidden behind a dialog, so its rows are not reserved.
  expect(dockRows({ view: "dialog", viewport: 50, selectRows: 1 })).toBe(DOCK_ROWS - DOCK_PROMPT_ROWS + 1)
})

test("dialogs that are not select-based fall back to the tall dock", () => {
  expect(dockRows({ view: "dialog", viewport: 50 })).toBe(DOCK_TALL_ROWS + 5)
  expect(dockRows({ view: "dialog", viewport: 20 })).toBe(DOCK_TALL_ROWS)
})

test("permission and question prompts always take the tall dock", () => {
  expect(dockRows({ view: "permission", viewport: 60 })).toBe(30)
  expect(dockRows({ view: "question", viewport: 60, selectRows: 3 })).toBe(30)
})

test("rows never exceed the viewport or drop below one", () => {
  expect(dockRows({ view: "prompt", viewport: 4 })).toBe(4)
  expect(dockRows({ view: "permission", viewport: 6 })).toBe(6)
  expect(dockRows({ view: "prompt", viewport: 0 })).toBe(1)
})
