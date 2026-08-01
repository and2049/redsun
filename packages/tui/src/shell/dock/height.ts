// Footer-region row policy for the dense dock.
//
// Modelled on --mini's `applyHeight` (packages/redsun/src/cli/cmd/run/footer.ts):
// each view declares its rows rather than measuring, so the height is
// deterministic and unit-testable. The dock applies the result through
// `applyFooterHeight`, which is idempotent, so a RESIZE-driven recompute cannot
// oscillate.

export const DOCK_STATUS_ROWS = 1
export const DOCK_FOOTER_ROWS = 2
// DenseApp renders the vim command bar as the last row of the footer region,
// below the dock itself — it still consumes footer rows.
export const DOCK_COMMAND_BAR_ROWS = 1
// Dense prompt chrome: rule + textarea + badge row + hint row.
export const DOCK_PROMPT_ROWS = 4
// Rows reserved for the `:` suggestion list while the vim command bar is open.
export const DOCK_COMMAND_ROWS = 10

export const DOCK_BASE_ROWS = DOCK_STATUS_ROWS + DOCK_FOOTER_ROWS + DOCK_COMMAND_BAR_ROWS
export const DOCK_ROWS = DOCK_BASE_ROWS + DOCK_PROMPT_ROWS
export const DOCK_TALL_ROWS = 20

export type DockView = "prompt" | "dialog" | "permission" | "question"

export function dockRows(input: {
  view: DockView
  viewport: number
  tail?: number
  notice?: boolean
  // Rows requested by a mounted inline select; 0 for dialogs that are not
  // select-based (help, timeline, alerts) — those keep their classic layout
  // and need the tall dock.
  selectRows?: number
  commandBar?: boolean
}): number {
  const viewport = Math.max(1, input.viewport)
  const tall = Math.max(DOCK_TALL_ROWS, Math.floor(viewport / 2))
  const extra = Math.max(0, input.tail ?? 0) + (input.notice ? 1 : 0)

  const rows = (() => {
    if (input.view === "permission" || input.view === "question") return tall
    if (input.view === "dialog") {
      const select = input.selectRows ?? 0
      return select > 0 ? DOCK_BASE_ROWS + extra + select : tall
    }
    return DOCK_BASE_ROWS + extra + DOCK_PROMPT_ROWS + (input.commandBar ? DOCK_COMMAND_ROWS : 0)
  })()

  return Math.min(Math.max(1, rows), viewport)
}
