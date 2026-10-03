import path from "node:path"
import { OPENCODE_CHANNEL } from "./version"

export const INSTALLED_DATABASE = "redsun-release.db"
export const LOCAL_DATABASE = "redsun-local.db"

export function databaseFilename(channel: string, env: Record<string, string | undefined> = process.env) {
  if (env.OPENCODE_DB) return env.OPENCODE_DB
  if (channel !== "local") return INSTALLED_DATABASE
  if (env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true") return INSTALLED_DATABASE
  return LOCAL_DATABASE
}

export function databasePath(data: string) {
  const filename = databaseFilename(OPENCODE_CHANNEL)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
