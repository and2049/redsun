import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { ToolRegistry } from "../tool/registry"
import { PromptTemplate } from "../prompt/template"
import type { Extension } from "../extension/types"
import { State } from "../project/state"
import { GlobalBus } from "../bus/global"

export namespace Command {
  export const Event = {
    Executed: BusEvent.define(
      "command.executed",
      z.object({
        name: z.string(),
        sessionID: Identifier.schema("session"),
        arguments: z.string(),
        messageID: Identifier.schema("message"),
      }),
    ),
  }

  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      agent: z.string().optional(),
      model: z.string().optional(),
      template: z.string(),
      subtask: z.boolean().optional(),
    })
    .meta({
      ref: "Command",
    })
  export interface Info extends z.infer<typeof Info> {
    handler?: Extension.RegisteredCommand["handler"]
  }

  export const Default = {
    INIT: "init",
    REVIEW: "review",
    GOAL: "goal",
  } as const

  async function initState() {
    const cfg = await Config.get()

    const result: Record<string, Info> = {
      [Default.INIT]: {
        name: Default.INIT,
        description: "create/update AGENTS.md",
        template: PROMPT_INITIALIZE.replace("${path}", Instance.worktree),
      },
      [Default.REVIEW]: {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        template: PROMPT_REVIEW.replace("${path}", Instance.worktree),
        subtask: true,
      },
    }

    for (const [name, command] of Object.entries(cfg.command ?? {})) {
      result[name] = {
        name,
        agent: command.agent,
        model: command.model,
        description: command.description,
        template: command.template,
        subtask: command.subtask,
      }
    }

    try {
      const runner = await ToolRegistry.getRunner()
      for (const [name, cmd] of runner.commands) {
        result[name] = {
          name,
          description: cmd.description,
          template: "",
          handler: cmd.handler,
        }
      }
    } catch {}

    for (const pt of await PromptTemplate.all()) {
      result[pt.name] = {
        name: pt.name,
        description: pt.description,
        template: pt.content,
      }
    }

    return result
  }

  const state = Instance.state(initState)

  export function invalidate(directory = Instance.directory) {
    State.reset(directory, initState)
  }

  GlobalBus.on("event", (evt) => {
    if (evt.payload?.type === "tool.registry.changed" && evt.directory) {
      invalidate(evt.directory)
    }
  })

  export async function get(name: string) {
    return state().then((x) => x[name])
  }

  export async function list() {
    return state().then((x) => Object.values(x))
  }
}
