import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { Global } from "@opencode-ai/core/global"

type TrustFile = Record<string, boolean | null | undefined>
export type Decision = boolean | null

const normalize = (value: string) => resolve(value).replace(/\\/g, "/")
const storePath = () => join(Global.Path.config, "trust.json")
const session = new Map<string, boolean>()

function read(): TrustFile {
  const file = storePath()
  if (!existsSync(file)) return {}
  const value = JSON.parse(readFileSync(file, "utf8")) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid trust store: ${file}`)
  for (const [key, decision] of Object.entries(value)) {
    if (decision !== true && decision !== false && decision !== null)
      throw new Error(`Invalid trust decision for ${key}`)
  }
  return value as TrustFile
}

export function get(directory: string): Decision {
  const data = read()
  let current = normalize(directory)
  while (true) {
    const decision = data[current]
    if (decision === true || decision === false) return decision
    const parent = dirname(current).replace(/\\/g, "/")
    if (parent === current) return null
    current = parent
  }
}

export function set(directory: string, decision: Decision) {
  const file = storePath()
  const data = read()
  const key = normalize(directory)
  if (decision === null) delete data[key]
  else data[key] = decision
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(Object.fromEntries(Object.entries(data).sort()), null, 2)}\n`, "utf8")
}

export function setSession(directory: string, decision: boolean) {
  session.set(normalize(directory), decision)
}

export function resolveDefault(directory: string, policy: "ask" | "always" | "never" | undefined) {
  return session.get(normalize(directory)) ?? get(directory) ?? policy === "always"
}
