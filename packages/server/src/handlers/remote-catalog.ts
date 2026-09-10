import { Agent } from "@opencode/core/agent"
import { Catalog } from "@opencode/core/catalog"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { remoteTheme } from "../remote-theme"

export const RemoteCatalogHandler = HttpApiBuilder.group(Api, "server.remoteCatalog", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const fs = yield* FileSystem.FileSystem
    return handlers
      .handle("remoteCatalog.theme", () => remoteTheme(global.config, fs))
      .handle("remoteCatalog.agents", () =>
        response(
          Agent.Service.use((agent) => agent.list()).pipe(
            Effect.map((agents) =>
              agents
                .filter((agent) => !agent.hidden && agent.mode !== "subagent")
                .map(({ id, name, mode }) => ({ id, name, mode })),
            ),
          ),
        ),
      )
      .handle("remoteCatalog.models", () =>
        response(
          Catalog.Service.use((catalog) => catalog.model.available()).pipe(
            Effect.map((models) =>
              models.map(({ id, providerID, name, variants }) => ({
                id,
                providerID,
                name,
                variants: variants.map(({ id }) => ({ id })),
              })),
            ),
          ),
        ),
      )
  }),
)
