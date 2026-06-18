import fuzzysort from "fuzzysort"

export const COMMAND_ALIASES: Record<string, string> = {
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
  mode: "theme.switch_mode",
  appearance: "theme.switch_mode",
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

export function resolveCommandAlias(input: string) {
  const command = input.trim().toLowerCase()
  return COMMAND_ALIASES[command] ?? command
}

export function getCommandSuggestions(input: string, limit: number) {
  const query = input.trim().toLowerCase()
  if (!query) return []
  return fuzzysort
    .go(query, Object.keys(COMMAND_ALIASES))
    .map((res) => res.target)
    .slice(0, limit)
}
