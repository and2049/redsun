import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { ClaudeCodeModels } from "@/claude-code/models"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import COMPOSE_MODE from "./prompt/compose-mode.txt"
import WORKER_MODE from "./prompt/worker-mode.txt"

export type Toggles = { plan?: boolean; compose?: boolean; worker?: boolean; build_switch?: boolean }

function toggles(input?: Toggles) {
  return {
    plan: input?.plan !== false,
    compose: input?.compose !== false,
    worker: input?.worker !== false,
    build_switch: input?.build_switch !== false,
  }
}

// REDSUN: standing agent-mode briefs (plan/compose/worker) are stable system
// fragments for non-delegated sessions — injected once per request in the
// cached system prefix instead of as an ephemeral message part whose
// disappearance from replay broke the provider cache prefix every turn.
// Delegated Claude Code turns receive no system prompt, so their briefs stay
// message parts (see apply below and claude-code/modes.ts). The experimental
// plan mode keeps its own persisted plan-file machinery in apply.
export function systemBrief(input: {
  agentName: string
  delegated: boolean
  experimentalPlanMode: boolean
  reminders?: Toggles
}): string | undefined {
  if (input.delegated) return undefined
  const enabled = toggles(input.reminders)
  if (input.agentName === "compose" && enabled.compose) return COMPOSE_MODE
  if (input.agentName === "worker" && enabled.worker) return WORKER_MODE
  if (input.agentName === "plan" && enabled.plan && !input.experimentalPlanMode) return PROMPT_PLAN
  return undefined
}

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
  model: { providerID: string }
  // REDSUN: per-reminder config toggles; every reminder defaults to enabled.
  reminders?: Toggles
}) {
  const enabled = toggles(input.reminders)
  // REDSUN CLAUDE-CODE: delegated sessions run Claude Code's own plan mode,
  // which owns read-only enforcement and its own plan file. Redsun's plan
  // reminders name a plan path the CLI will not write, so they are skipped;
  // the compose and worker reminders below are model-agnostic and stay.
  const delegated = ClaudeCodeModels.isDelegated(input.model)
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // REDSUN: compose/worker briefs stay message parts only for delegated
  // sessions (Claude Code interactive turns have no system prompt); everyone
  // else gets them through systemBrief in the stable system prefix.
  const reminder = delegated
    ? input.agent.name === "compose" && enabled.compose
      ? COMPOSE_MODE
      : input.agent.name === "worker" && enabled.worker
        ? WORKER_MODE
        : undefined
    : undefined
  if (reminder) {
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: reminder,
      synthetic: true,
    })
  }

  if (!flags.experimentalPlanMode) {
    // REDSUN: the switch notice fires only when the most recent assistant turn
    // came from the plan agent, so it appears once per plan->build switch
    // instead of on every turn for the rest of the session. It is persisted so
    // replay on later turns matches the request that carried it (cache-stable).
    const lastAssistant = input.messages.findLast((msg) => msg.info.role === "assistant")
    const wasPlan = lastAssistant?.info.agent === "plan"
    if (wasPlan && input.agent.name === "build" && enabled.build_switch) {
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
      userMessage.parts.push(part)
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan" && enabled.build_switch) {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = !delegated && (yield* fsys.existsSafe(plan))
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan" || delegated || !enabled.plan)
    return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
