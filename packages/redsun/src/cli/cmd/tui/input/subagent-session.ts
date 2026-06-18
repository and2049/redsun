export type SessionGroupItem = {
  id: string
  title: string
  parentID?: string
}

export type SessionGroupPermission = {
  sessionID: string
  permission: unknown
}

export type SessionGroupStatus = {
  type?: string
}

export type SubagentSessionOption = {
  id: string
  title: string
  description: string
  footer: string
  current: boolean
  parent: boolean
}

export type SubagentHeaderInfo = {
  index: number
  total: number
  title: string
}

function sortSessions(a: SessionGroupItem, b: SessionGroupItem) {
  return a.id.localeCompare(b.id)
}

export function getSessionGroup(sessions: readonly SessionGroupItem[], currentID: string) {
  const current = sessions.find((item) => item.id === currentID)
  if (!current) return []
  const parentID = current.parentID ?? current.id
  return sessions
    .filter((item) => item.id === parentID || item.parentID === parentID)
    .toSorted((a, b) => {
      if (a.id === parentID) return -1
      if (b.id === parentID) return 1
      return a.id.localeCompare(b.id)
    })
}

export function isSubagentSession(session: Pick<SessionGroupItem, "parentID"> | undefined) {
  return !!session?.parentID
}

export function getSubagentHeaderInfo(
  sessions: readonly SessionGroupItem[],
  currentID: string,
): SubagentHeaderInfo | undefined {
  const current = sessions.find((item) => item.id === currentID)
  if (!current?.parentID) return
  const siblings = sessions.filter((item) => item.parentID === current.parentID).toSorted(sortSessions)
  const index = siblings.findIndex((item) => item.id === currentID)
  if (index === -1) return
  return {
    index: index + 1,
    total: siblings.length,
    title: current.title,
  }
}

export function getChildCycleTarget(
  sessions: readonly SessionGroupItem[],
  currentID: string,
  direction: 1 | -1,
): string | undefined {
  const current = sessions.find((item) => item.id === currentID)
  if (!current) return
  const parentID = current.parentID ?? current.id
  const children = sessions.filter((item) => item.parentID === parentID).toSorted(sortSessions)
  if (children.length === 0) return

  if (!current.parentID) {
    return direction > 0 ? children[0]?.id : children[children.length - 1]?.id
  }

  let next = children.findIndex((item) => item.id === currentID) + direction
  if (next >= children.length) next = 0
  if (next < 0) next = children.length - 1
  return children[next]?.id
}

export function getFirstSessionGroupPermission(
  sessions: readonly SessionGroupItem[],
  currentID: string,
  permissions: Record<string, readonly unknown[] | undefined>,
): SessionGroupPermission | undefined {
  const group = getSessionGroup(sessions, currentID)
  const current = group.find((item) => item.id === currentID)
  const ordered = current ? [current, ...group.filter((item) => item.id !== currentID)] : group
  for (const item of ordered) {
    const permission = permissions[item.id]?.[0]
    if (permission) return { sessionID: item.id, permission }
  }
}

export function buildSubagentSessionOptions(input: {
  sessions: readonly SessionGroupItem[]
  currentID: string
  permissions: Record<string, readonly unknown[] | undefined>
  statuses?: Record<string, SessionGroupStatus | undefined>
}) {
  const group = getSessionGroup(input.sessions, input.currentID)
  const parentID = group[0]?.id
  return group.map((item): SubagentSessionOption => {
    const permissionCount = input.permissions[item.id]?.length ?? 0
    const status = input.statuses?.[item.id]?.type
    const footer = [
      item.id === input.currentID ? "current" : undefined,
      permissionCount > 0 ? `${permissionCount} permission${permissionCount === 1 ? "" : "s"}` : undefined,
      status && status !== "idle" ? status : undefined,
    ]
      .filter(Boolean)
      .join(" · ")

    return {
      id: item.id,
      title: item.id === parentID ? `Main: ${item.title}` : item.title,
      description: item.id === parentID ? "parent session" : "subagent session",
      footer,
      current: item.id === input.currentID,
      parent: item.id === parentID,
    }
  })
}
