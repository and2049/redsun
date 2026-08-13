const EXPAND_HINT = " (click to expand)"
/** InlineTool row overhead: box paddingLeft (3) + icon column (2). */
const ROW_PREFIX = 5

/**
 * Collapse decision for a generic tool row. Foreign tools (e.g. Claude
 * Code's own Edit) serialize multi-line args into the detail text, so a
 * single call can swallow the screen: anything that would span more than one
 * terminal row — multi-line detail, an output block, or overflow of the
 * flattened text — collapses to a one-row teaser by default.
 */
export function toolTeaser(input: { detail: string; output: string; width: number }): {
  collapsible: boolean
  teaser: string
} {
  const flat = `${input.detail}${input.output ? " " + input.output : ""}`.replace(/\s+/g, " ").trim()
  const available = Math.max(10, input.width - ROW_PREFIX - EXPAND_HINT.length)
  const collapsible = Boolean(input.output) || input.detail.includes("\n") || flat.length > available
  const teaser = flat.length <= available ? flat : flat.slice(0, available) + "…"
  return { collapsible, teaser }
}
