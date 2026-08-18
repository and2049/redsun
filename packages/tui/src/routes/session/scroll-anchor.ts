// Where each session was scrolled to, so leaving and coming back lands in the
// same place.
//
// Upstream hung this off the tab strip, keyed by a tab's root session and
// dropped when the tab closed. Redsun has no tab strip but still navigates
// between sessions constantly — parent to subagent and back is two keystrokes —
// so the state outlives any one view and lives here instead. `undefined` means
// "pinned to the bottom", which is also what an unknown session gets.
export interface ScrollAnchor {
  readonly messageID: string
  readonly screenY: number
}

const anchors = new Map<string, ScrollAnchor>()

export function scrollAnchor(sessionID: string) {
  return anchors.get(sessionID)
}

export function setScrollAnchor(sessionID: string, anchor: ScrollAnchor | undefined) {
  if (anchor === undefined) {
    anchors.delete(sessionID)
    return
  }
  anchors.set(sessionID, anchor)
}

export function forgetScrollAnchor(sessionID: string) {
  anchors.delete(sessionID)
}
