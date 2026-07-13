import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Global } from "../global"

export type ProjectTrustDecision = boolean | null

export interface ProjectTrustStoreEntry {
  path: string
  decision: boolean
}

export interface ProjectTrustUpdate {
  path: string
  decision: ProjectTrustDecision
}

export interface ProjectTrustOption {
  label: string
  trusted: boolean
  updates: ProjectTrustUpdate[]
  savedPath?: string
}

type TrustFile = Record<string, boolean | null | undefined>

const TRUST_REQUIRING_RESOURCES = [
  "redsun.json",
  "redsun.jsonc",
  "extensions",
  "skills",
  "prompts",
  "agents",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/")
}

function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
  let currentDir = normalizeCwd(cwd)
  while (true) {
    const value = data[currentDir]
    if (value === true || value === false) {
      return { path: currentDir, decision: value }
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return null
    }
    currentDir = parentDir
  }
}

export function getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): ProjectTrustOption[] {
  const trustPath = normalizeCwd(cwd)
  const trustOptions: ProjectTrustOption[] = [
    { label: "Trust", trusted: true, updates: [{ path: trustPath, decision: true }], savedPath: trustPath },
  ]
  const parentDir = dirname(trustPath)
  if (parentDir !== trustPath) {
    trustOptions.push({
      label: `Trust parent folder (${parentDir})`,
      trusted: true,
      updates: [
        { path: parentDir, decision: true },
        { path: trustPath, decision: null },
      ],
      savedPath: parentDir,
    })
  }
  if (options?.includeSessionOnly) {
    trustOptions.push({ label: "Trust (this session only)", trusted: true, updates: [] })
  }
  trustOptions.push({
    label: "Do not trust",
    trusted: false,
    updates: [{ path: trustPath, decision: false }],
    savedPath: trustPath,
  })
  if (options?.includeSessionOnly) {
    trustOptions.push({ label: "Do not trust (this session only)", trusted: false, updates: [] })
  }
  return trustOptions
}

function readTrustFile(path: string): TrustFile {
  if (!existsSync(path)) {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read trust store ${path}: ${message}`)
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid trust store ${path}: expected an object`)
  }

  const data: TrustFile = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== true && value !== false && value !== null) {
      throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`)
    }
    data[key] = value
  }
  return data
}

function writeTrustFile(path: string, data: TrustFile): void {
  const sorted: TrustFile = {}
  for (const key of Object.keys(data).sort()) {
    const value = data[key]
    if (value === true || value === false || value === null) {
      sorted[key] = value
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8")
}

export function hasTrustRequiringProjectResources(cwd: string, worktree = cwd): boolean {
  let currentDir = resolve(cwd)
  const boundary = resolve(worktree)
  const withinWorktree = relative(boundary, currentDir)
  const stop = withinWorktree.startsWith("..") || isAbsolute(withinWorktree) ? currentDir : boundary

  while (true) {
    const configDir = join(currentDir, ".redsun")
    if (
      TRUST_REQUIRING_RESOURCES.some((entry) => existsSync(join(configDir, entry))) ||
      ["redsun.json", "redsun.jsonc"].some((entry) => existsSync(join(currentDir, entry)))
    ) {
      return true
    }

    if (currentDir === stop) break
    const parent = dirname(currentDir)
    if (parent === currentDir) break
    currentDir = parent
  }

  return false
}

export class ProjectTrustStore {
  private trustPath: string

  constructor(agentDir: string) {
    this.trustPath = join(agentDir, "trust.json")
  }

  get(cwd: string): ProjectTrustDecision {
    return this.getEntry(cwd)?.decision ?? null
  }

  getEntry(cwd: string): ProjectTrustStoreEntry | null {
    const data = readTrustFile(this.trustPath)
    return findNearestTrustEntry(data, cwd)
  }

  set(cwd: string, decision: ProjectTrustDecision): void {
    this.setMany([{ path: cwd, decision }])
  }

  setMany(decisions: ProjectTrustUpdate[]): void {
    const data = readTrustFile(this.trustPath)
    for (const { path, decision } of decisions) {
      const key = normalizeCwd(path)
      if (decision === null) {
        delete data[key]
      } else {
        data[key] = decision
      }
    }
    writeTrustFile(this.trustPath, data)
  }
}

export function createTrustStore(): ProjectTrustStore {
  return new ProjectTrustStore(Global.Path.config)
}
