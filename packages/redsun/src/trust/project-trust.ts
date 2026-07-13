import type { Extension } from "../extension/types"
import { ExtensionRunner } from "../extension/runner"
import {
  getProjectTrustOptions,
  hasTrustRequiringProjectResources,
  type ProjectTrustOption,
  type ProjectTrustStore,
} from "./manager"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "../bus"
import z from "zod"
import { Instance } from "../project/instance"

export const TrustPromptEvent = BusEvent.define(
  "trust.prompt",
  z.object({
    cwd: z.string(),
    options: z.array(z.object({
      label: z.string(),
      trusted: z.boolean(),
      sessionOnly: z.boolean(),
    })),
  }),
)

export const TrustResolvedEvent = BusEvent.define(
  "trust.resolved",
  z.object({
    cwd: z.string(),
    trusted: z.boolean(),
  }),
)

export interface ResolveProjectTrustedOptions {
  cwd: string
  trustStore: ProjectTrustStore
  trustOverride?: boolean
  defaultProjectTrust?: "ask" | "always" | "never"
  runner?: ExtensionRunner.State
  mode: Extension.Mode
  hasUI: boolean
  ui: Extension.UIContext
  sessionID?: string
}

function formatProjectTrustPrompt(cwd: string): string {
  return `Trust project folder?\n${cwd}\n\nThis allows redsun to load .redsun settings and resources, install missing project packages, and execute project extensions.`
}

async function selectProjectTrustOption(cwd: string, ui: Extension.UIContext): Promise<ProjectTrustOption | undefined> {
  const options = getProjectTrustOptions(cwd, { includeSessionOnly: true })
  const selected = await ui.select(
    formatProjectTrustPrompt(cwd),
    options.map((option) => option.label),
  )
  return options.find((option) => option.label === selected)
}

function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
  if (result.updates.length > 0) {
    trustStore.setMany(result.updates)
  }
}

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
  if (options.trustOverride !== undefined) {
    return options.trustOverride
  }

  if (!hasTrustRequiringProjectResources(options.cwd, Instance.worktree)) {
    return true
  }

  if (options.runner) {
    const ctx: Extension.ProjectTrustContext = {
      cwd: options.cwd,
      mode: options.mode,
      hasUI: options.hasUI,
      ui: options.ui,
    }
    const result = await ExtensionRunner.emitProjectTrust(
      options.runner,
      { type: "project_trust", cwd: options.cwd },
      ctx,
    )
    if (result) {
      const trusted = result.trusted === "yes"
      if (result.remember === true) {
        options.trustStore.set(options.cwd, trusted)
      }
      return trusted
    }
  }

  const decision = options.trustStore.get(options.cwd)
  if (decision !== null) {
    return decision
  }

  switch (options.defaultProjectTrust ?? "ask") {
    case "always":
      return true
    case "never":
      return false
    case "ask":
      break
  }

  if (!options.hasUI) {
    const trustOptions = getProjectTrustOptions(options.cwd, { includeSessionOnly: true })
    await Bus.publish(TrustPromptEvent, {
      cwd: options.cwd,
      options: trustOptions.map((opt) => ({
        label: opt.label,
        trusted: opt.trusted,
        sessionOnly: opt.updates.length === 0,
      })),
    })
    return false
  }

  const selected = await selectProjectTrustOption(options.cwd, options.ui)
  if (selected !== undefined) {
    saveProjectTrustPromptResult(options.trustStore, selected)
    return selected.trusted
  }
  return false
}

export async function respondToTrustPrompt(cwd: string, trusted: boolean, remember: boolean): Promise<boolean> {
  const { createTrustStore } = await import("./manager")
  const trustStore = createTrustStore()
  if (remember) {
    trustStore.set(cwd, trusted)
  }
  await Bus.publish(TrustResolvedEvent, { cwd, trusted })
  return trusted
}
