import type { KeyEvent } from "@opentui/core"

export type VimMode = "insert" | "normal" | "command"

export const commandAliases: Record<string, string> = {
  ls: "session.list",
  session: "session.list",
  sessions: "session.list",
  new: "session.new",
  enew: "session.new",
  open: "open.menu",
  rename: "session.rename",
  timeline: "session.timeline",
  tl: "session.timeline",
  fork: "session.fork",
  compact: "session.compact",
  share: "session.share",
  unshare: "session.unshare",
  undo: "session.undo",
  u: "session.undo",
  redo: "session.redo",
  sidebar: "session.sidebar.toggle",
  interrupt: "session.interrupt",
  stop: "session.interrupt",
  subagents: "session.child.first",
  subs: "session.child.first",
  children: "session.child.first",
  parent: "session.parent",
  model: "model.list",
  models: "model.list",
  worker: "worker.model",
  mcycle: "model.cycle_recent",
  mcyclerev: "model.cycle_recent_reverse",
  mfav: "model.cycle_favorite",
  mfavrev: "model.cycle_favorite_reverse",
  agent: "agent.list",
  agents: "agent.list",
  acycle: "agent.cycle",
  acyclerev: "agent.cycle.reverse",
  mcp: "mcp.list",
  mcps: "mcp.list",
  provider: "provider.connect",
  providers: "provider.connect",
  clear: "prompt.clear",
  submit: "prompt.submit",
  paste: "prompt.paste",
  stash: "prompt.stash",
  pop: "prompt.stash.pop",
  stashes: "prompt.stash.list",
  theme: "theme.switch",
  themes: "theme.switch",
  appearance: "theme.switch",
  status: "opencode.status",
  settings: "opencode.settings",
  export: "session.export",
  editor: "prompt.editor",
  cd: "session.cd",
  help: "help.show",
  h: "help.show",
  q: "app.exit",
  qa: "app.exit",
  qw: "app.exit",
  wq: "app.exit",
  exit: "app.exit",
  quit: "app.exit",
  debug: "app.debug",
  console: "app.console",
  suspend: "terminal.suspend",
}

export function resolveCommand(input: string) {
  const command = input.trim().toLowerCase()
  return commandAliases[command] ?? command
}

export function transition(mode: VimMode, event: Pick<KeyEvent, "name" | "ctrl" | "meta">): VimMode | undefined {
  if (event.ctrl || event.meta) return
  if (mode === "insert" && event.name === "escape") return "normal"
  if (mode === "normal" && event.name === "i") return "insert"
  if (mode === "normal" && event.name === ":") return "command"
  if (mode === "command" && (event.name === "escape" || event.name === "return")) return "normal"
}

export const COUNT_MAX = 999

export function pushCount(current: number | null, digit: number): number | null {
  if (digit === 0 && current === null) return null
  return Math.min(COUNT_MAX, (current ?? 0) * 10 + digit)
}

export const NORMAL_LETTER_COMMANDS: Record<string, string> = {
  a: "agent.list",
  b: "session.sidebar.toggle",
  c: "session.compact",
  e: "prompt.editor",
  g: "session.timeline",
  l: "session.list",
  m: "model.list",
  n: "session.new",
  o: "open.menu",
  p: "command.palette.show",
  r: "session.redo",
  s: "opencode.status",
  t: "theme.switch",
  u: "session.undo",
  w: "worker.model",
  x: "session.export",
  y: "messages.copy",
}
