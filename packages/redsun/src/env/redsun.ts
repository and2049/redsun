const REDSUN_PREFIX = "REDSUN_"
const OPENCODE_PREFIX = "OPENCODE_"

export function applyRedsunEnv() {
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith(REDSUN_PREFIX)) {
      process.env[OPENCODE_PREFIX + key.slice(REDSUN_PREFIX.length)] ??= value
    } else if (key.startsWith(OPENCODE_PREFIX)) {
      process.env[REDSUN_PREFIX + key.slice(OPENCODE_PREFIX.length)] ??= value
    }
  }
}

export function setRedsunEnv(name: string, value: string) {
  process.env[`REDSUN_${name}`] = value
  process.env[`OPENCODE_${name}`] = value
}
