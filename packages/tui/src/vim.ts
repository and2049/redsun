import type { KeyEvent } from "@opentui/core"

export type VimMode = "insert" | "normal" | "command"

export const commandAliases: Record<string, string> = {
  ls: "session.list",
  session: "session.list",
  sessions: "session.list",
  new: "session.new",
  enew: "session.new",
  rename: "session.rename",
  timeline: "session.timeline",
  tl: "session.timeline",
  fork: "session.fork",
  compact: "session.compact",
  unshare: "session.unshare",
  undo: "session.undo",
  u: "session.undo",
  redo: "session.redo",
  sidebar: "session.sidebar.toggle",
  interrupt: "session.interrupt",
  stop: "session.interrupt",
  subagents: "session.subagents",
  subs: "session.subagents",
  children: "session.subagents",
  model: "model.list",
  models: "model.list",
  mcycle: "model.cycle_recent",
  mcyclerev: "model.cycle_recent_reverse",
  mfav: "model.cycle_favorite",
  mfavrev: "model.cycle_favorite_reverse",
  agent: "agent.list",
  agents: "agent.toggle",
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
  tips: "tips.toggle",
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

// null = no pending count. A leading 0 stays inert so 0 can keep its literal
// meaning; it only appends to an existing count (vim's 10j, not 0j).
export function pushCount(current: number | null, digit: number): number | null {
  if (digit === 0 && current === null) return null
  return Math.min(COUNT_MAX, (current ?? 0) * 10 + digit)
}
