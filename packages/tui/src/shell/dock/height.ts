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
// Rows reserved for the prompt's `/` and `@` completion popup, which draws
// upward from the prompt anchor and clamps to the space above it.
export const DOCK_AUTOCOMPLETE_ROWS = 11

export const DOCK_BASE_ROWS = DOCK_STATUS_ROWS + DOCK_FOOTER_ROWS + DOCK_COMMAND_BAR_ROWS
export const DOCK_ROWS = DOCK_BASE_ROWS + DOCK_PROMPT_ROWS
export const DOCK_TALL_ROWS = 20

export type DockView = "prompt" | "dialog" | "permission" | "question"

// `dialog.size`, which dialogs set for themselves in classic. Dense reuses it
// as the tall-dock sizing signal: a select-based dialog declares exact rows,
// everything else gets a share of the viewport by how big it asked to be.
// "xlarge" (the plugin browser, move-session) takes the whole viewport, which
// is also how the diff viewer gets a full screen.
export type DockDialogSize = "medium" | "large" | "xlarge"

// View precedence. A dialog outranks a pending permission or question so that
// one arriving mid-picker queues behind it and appears when the picker closes,
// rather than yanking the view out from under the user mid-selection.
export function dockView(input: { dialogs: number; permissions: number; questions: number }): DockView {
  if (input.dialogs > 0) return "dialog"
  if (input.permissions > 0) return "permission"
  if (input.questions > 0) return "question"
  return "prompt"
}

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
  autocomplete?: boolean
  // How much room a non-select dialog asked for (see DockDialogSize).
  dialogSize?: DockDialogSize
  // Queued prompt rows and the subagent strip, both above the status row.
  queued?: number
  subagent?: boolean
  // False while a permission or question owns the view; the prompt stays
  // mounted (and sized for) under an open dialog so commands that write to it
  // through `usePromptRef` still find a live ref.
  prompt?: boolean
}): number {
  const viewport = Math.max(1, input.viewport)
  const tall = Math.max(DOCK_TALL_ROWS, Math.floor(viewport / 2))
  const extra =
    Math.max(0, input.tail ?? 0) + Math.max(0, input.queued ?? 0) + (input.notice ? 1 : 0) + (input.subagent ? 1 : 0)

  const rows = (() => {
    if (input.view === "permission" || input.view === "question") return tall
    if (input.view === "dialog") {
      const select = input.selectRows ?? 0
      if (select <= 0) {
        if (input.dialogSize === "xlarge") return viewport
        if (input.dialogSize === "large") return Math.max(tall, Math.floor((viewport * 3) / 4))
        return tall
      }
      return DOCK_BASE_ROWS + extra + select + (input.prompt === false ? 0 : DOCK_PROMPT_ROWS)
    }
    return (
      DOCK_BASE_ROWS +
      extra +
      DOCK_PROMPT_ROWS +
      (input.commandBar ? DOCK_COMMAND_ROWS : 0) +
      (input.autocomplete ? DOCK_AUTOCOMPLETE_ROWS : 0)
    )
  })()

  return Math.min(Math.max(1, rows), viewport)
}
