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
