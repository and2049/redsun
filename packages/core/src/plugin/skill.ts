/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeRedsunContent from "./skill/customize-redsun.md" with { type: "text" }

export const CustomizeRedsunContent = customizeRedsunContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-redsun",
            description:
              "Use ONLY when the user is editing or creating redsun's own configuration: redsun.json, redsun.jsonc, files under .redsun/, or files under ~/.config/redsun/. Also use when creating or fixing redsun agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring redsun itself.",
            location: AbsolutePath.make("/builtin/customize-redsun.md"),
            content: CustomizeRedsunContent,
          }),
        }),
      )
    })
  }),
})
