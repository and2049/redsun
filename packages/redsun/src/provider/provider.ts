import z from "zod"
import fuzzysort from "fuzzysort"
import { Config } from "../config/config"
import { mapValues, mergeDeep, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { BunProc } from "../bun"

import { ModelsDev } from "./models"
import { NamedError } from "@redsun/util/error"
import { Auth } from "../auth"
import { Env } from "../env"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { OpenAICodexOAuth } from "./openai-codex-oauth"
import { ProviderTransform } from "./transform"

// Direct imports for bundled providers
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createAzure } from "@ai-sdk/azure"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import { createVertexAnthropic } from "@ai-sdk/google-vertex/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter, type LanguageModelV2 } from "@openrouter/ai-sdk-provider"
import { createOpenaiCompatible as createGitHubCopilotOpenAICompatible } from "./sdk/openai-compatible/src"
import { createXai } from "@ai-sdk/xai"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createCerebras } from "@ai-sdk/cerebras"
import { createCohere } from "@ai-sdk/cohere"
import { createGateway } from "@ai-sdk/gateway"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { createPerplexity } from "@ai-sdk/perplexity"

export function resolveBedrockModelID(modelID: string, region: string) {
  if (["global.", "us.", "eu.", "jp.", "apac.", "au."].some((prefix) => modelID.startsWith(prefix))) return modelID

  const prefix = region.split("-")[0]
  if (prefix === "us") {
    const required = ["nova-micro", "nova-lite", "nova-pro", "nova-premier", "nova-2", "claude", "deepseek"]
    return required.some((name) => modelID.includes(name)) && !region.startsWith("us-gov") ? `us.${modelID}` : modelID
  }
  if (prefix === "eu") {
    const supported = ["eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-central-1", "eu-south-1", "eu-south-2"]
    const required = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"]
    return supported.includes(region) && required.some((name) => modelID.includes(name)) ? `eu.${modelID}` : modelID
  }
  if (prefix !== "ap") return modelID

  const required = ["claude", "nova-lite", "nova-micro", "nova-pro"]
  if (["ap-southeast-2", "ap-southeast-4"].includes(region)) {
    const australian = ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"]
    if (australian.some((name) => modelID.includes(name))) return `au.${modelID}`
  }
  if (!required.some((name) => modelID.includes(name))) return modelID
  return `${region === "ap-northeast-1" ? "jp" : "apac"}.${modelID}`
}

export function googleVertexAnthropicBaseURL(project: string | undefined, location: string | undefined) {
  if (!project || (location !== "eu" && location !== "us")) return undefined
  return `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`
}

export namespace Provider {
  const log = Log.create({ service: "provider" })

  const BUNDLED_PROVIDERS: Record<string, (options: any) => SDK> = {
    "@ai-sdk/amazon-bedrock": createAmazonBedrock,
    "@ai-sdk/anthropic": createAnthropic,
    "@ai-sdk/azure": createAzure,
    "@ai-sdk/google": createGoogleGenerativeAI,
    "@ai-sdk/google-vertex": createVertex,
    "@ai-sdk/google-vertex/anthropic": createVertexAnthropic,
    "@ai-sdk/openai": createOpenAI,
    "@ai-sdk/openai-compatible": createOpenAICompatible,
    "@openrouter/ai-sdk-provider": createOpenRouter,
    "@ai-sdk/xai": createXai,
    "@ai-sdk/mistral": createMistral,
    "@ai-sdk/groq": createGroq,
    "@ai-sdk/deepinfra": createDeepInfra,
    "@ai-sdk/cerebras": createCerebras,
    "@ai-sdk/cohere": createCohere,
    "@ai-sdk/gateway": createGateway,
    "@ai-sdk/togetherai": createTogetherAI,
    "@ai-sdk/perplexity": createPerplexity,
    // @ts-ignore (TODO: kill this code so we dont have to maintain it)
    "@ai-sdk/github-copilot": createGitHubCopilotOpenAICompatible,
  }

  type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>, model?: Model) => Promise<any>
  type CustomLoader = (provider: Info) => Promise<{
    autoload: boolean
    getModel?: CustomModelLoader
    options?: Record<string, any>
  }>

  const CUSTOM_LOADERS: Record<string, CustomLoader> = {
    async anthropic() {
      return {
        autoload: false,
        options: {
          headers: {
            "anthropic-beta":
              "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }
    },
    openai: async () => {
      const auth = await Auth.get("openai")
      const oauth = auth?.type === "oauth" ? auth : undefined
      return {
        autoload: !!oauth,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: oauth
          ? {
              apiKey: OpenAICodexOAuth.DUMMY_API_KEY,
              fetch: OpenAICodexOAuth.createFetch({
                getAuth: () => Auth.get("openai"),
                setAuth: (auth) => Auth.set("openai", auth),
              }),
            }
          : {},
      }
    },
    meta: async () => ({
      autoload: false,
      async getModel(sdk: any, modelID: string) {
        return sdk.responses(modelID)
      },
      options: {},
    }),
    "github-copilot": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>, model?: Model) {
          const endpoint = (model?.api as any)?.endpoint
          if (endpoint === "responses" && sdk.responses) return sdk.responses(modelID)
          if (endpoint === "chat" && sdk.chat) return sdk.chat(modelID)
          if (modelID.includes("codex")) return sdk.responses(modelID)
          return sdk.chat(modelID)
        },
        options: {},
      }
    },
    "github-copilot-enterprise": async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>, model?: Model) {
          const endpoint = (model?.api as any)?.endpoint
          if (endpoint === "responses" && sdk.responses) return sdk.responses(modelID)
          if (endpoint === "chat" && sdk.chat) return sdk.chat(modelID)
          if (modelID.includes("codex")) return sdk.responses(modelID)
          return sdk.chat(modelID)
        },
        options: {},
      }
    },
    azure: async () => {
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {},
      }
    },
    async opencode(input) {
      const hasKey = await (async () => {
        const env = Env.all()
        if (input.env.some((item) => env[item])) return true
        if (await Auth.get(input.id)) return true
        const config = await Config.get()
        if (config.provider?.["opencode"]?.options?.apiKey) return true
        return false
      })()

      if (!hasKey) {
        for (const [key, value] of Object.entries(input.models)) {
          if (value.cost.input === 0) continue
          delete input.models[key]
        }
      }

      return {
        autoload: Object.keys(input.models).length > 0,
        options: hasKey ? {} : { apiKey: "public" },
      }
    },
    "azure-cognitive-services": async () => {
      const resourceName = Env.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (options?.["useCompletionUrls"]) {
            return sdk.chat(modelID)
          } else {
            return sdk.responses(modelID)
          }
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    },
    "amazon-bedrock": async (provider) => {
      const auth = await Auth.get("amazon-bedrock")
      const region = provider.options?.region ?? Env.get("AWS_REGION") ?? "us-east-1"
      const profile = provider.options?.profile ?? Env.get("AWS_PROFILE")
      const awsAccessKeyId = Env.get("AWS_ACCESS_KEY_ID")
      const configApiKey = provider.options?.apiKey
      const envBearerToken = Env.get("AWS_BEARER_TOKEN_BEDROCK")
      const awsBearerToken = envBearerToken ?? (auth?.type === "api" ? auth.key : undefined)
      const webIdentityToken = Env.get("AWS_WEB_IDENTITY_TOKEN_FILE")
      const containerCredentials = Boolean(
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      )
      if (!envBearerToken && awsBearerToken) Env.set("AWS_BEARER_TOKEN_BEDROCK", awsBearerToken)
      if (
        !profile &&
        !awsAccessKeyId &&
        !awsBearerToken &&
        !configApiKey &&
        !webIdentityToken &&
        !containerCredentials
      )
        return { autoload: false }

      const options: Record<string, any> = { region }
      if (!awsBearerToken && !configApiKey) {
        const { fromNodeProviderChain } = await import(await BunProc.install("@aws-sdk/credential-providers"))
        options.credentialProvider = fromNodeProviderChain(profile ? { profile } : {})
      }
      const endpoint = provider.options?.endpoint ?? provider.options?.baseURL
      if (endpoint) options.baseURL = endpoint

      return {
        autoload: true,
        options,
        async getModel(sdk: any, modelID: string, requestOptions?: Record<string, any>) {
          return sdk.languageModel(resolveBedrockModelID(modelID, requestOptions?.region ?? region))
        },
      }
    },
    openrouter: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://github.com/and2049/redsun",
            "X-Title": "Redsun",
          },
        },
      }
    },
    vercel: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://github.com/and2049/redsun",
            "x-title": "Redsun",
          },
        },
      }
    },
    "google-vertex": async (provider) => {
      const project =
        provider.options?.project ??
        Env.get("GOOGLE_VERTEX_PROJECT") ??
        Env.get("GOOGLE_CLOUD_PROJECT") ??
        Env.get("GCP_PROJECT") ??
        Env.get("GCLOUD_PROJECT")
      const location =
        provider.options?.location ??
        Env.get("GOOGLE_VERTEX_LOCATION") ??
        Env.get("GOOGLE_CLOUD_LOCATION") ??
        Env.get("VERTEX_LOCATION") ??
        "us-central1"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "google-vertex-anthropic": async () => {
      const project = Env.get("GOOGLE_CLOUD_PROJECT") ?? Env.get("GCP_PROJECT") ?? Env.get("GCLOUD_PROJECT")
      const location = Env.get("GOOGLE_CLOUD_LOCATION") ?? Env.get("VERTEX_LOCATION") ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        options: {
          project,
          location,
          ...(googleVertexAnthropicBaseURL(project, location)
            ? { baseURL: googleVertexAnthropicBaseURL(project, location) }
            : {}),
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    },
    "sap-ai-core": async () => {
      const auth = await Auth.get("sap-ai-core")
      const envServiceKey = iife(() => {
        const envAICoreServiceKey = Env.get("AICORE_SERVICE_KEY")
        if (envAICoreServiceKey) return envAICoreServiceKey
        if (auth?.type === "api") {
          Env.set("AICORE_SERVICE_KEY", auth.key)
          return auth.key
        }
        return undefined
      })
      const deploymentId = Env.get("AICORE_DEPLOYMENT_ID")
      const resourceGroup = Env.get("AICORE_RESOURCE_GROUP")

      return {
        autoload: !!envServiceKey,
        options: envServiceKey ? { deploymentId, resourceGroup } : {},
        async getModel(sdk: any, modelID: string) {
          return sdk(modelID)
        },
      }
    },
    zenmux: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://github.com/and2049/redsun",
            "X-Title": "Redsun",
          },
        },
      }
    },
    "cloudflare-ai-gateway": async (input) => {
      const accountId = Env.get("CLOUDFLARE_ACCOUNT_ID")
      const gateway = Env.get("CLOUDFLARE_GATEWAY_ID")

      if (!accountId || !gateway) return { autoload: false }

      // Get API token from env or auth prompt
      const apiToken = await (async () => {
        const envToken = Env.get("CLOUDFLARE_API_TOKEN")
        if (envToken) return envToken
        const auth = await Auth.get(input.id)
        if (auth?.type === "api") return auth.key
        return undefined
      })()

      return {
        autoload: true,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.chat(modelID)
        },
        options: {
          baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/compat`,
          headers: {
            // Cloudflare AI Gateway uses cf-aig-authorization for authenticated gateways
            // This enables Unified Billing where Cloudflare handles upstream provider auth
            ...(apiToken ? { "cf-aig-authorization": `Bearer ${apiToken}` } : {}),
            "HTTP-Referer": "https://github.com/and2049/redsun",
            "X-Title": "Redsun",
          },
          // Custom fetch to strip Authorization header - AI Gateway uses cf-aig-authorization instead
          // Sending Authorization header with invalid value causes auth errors
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            headers.delete("Authorization")
            return fetch(input, { ...init, headers })
          },
        },
      }
    },
    cerebras: async () => {
      return {
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "redsun",
          },
        },
      }
    },
  }

  export const Model = z
    .object({
      id: z.string(),
      providerID: z.string(),
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning", "reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        tiers: z
          .array(
            z.object({
              input: z.number(),
              output: z.number(),
              cache: z.object({ read: z.number(), write: z.number() }),
              tier: z.object({ type: z.literal("context"), size: z.number() }),
            }),
          )
          .optional(),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: z.string(),
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  function cost(value: ModelsDev.Model["cost"]): Model["cost"] {
    return {
      input: value?.input ?? 0,
      output: value?.output ?? 0,
      cache: {
        read: value?.cache_read ?? 0,
        write: value?.cache_write ?? 0,
      },
      tiers: value?.tiers?.map((item) => ({
        input: item.input,
        output: item.output,
        cache: { read: item.cache_read ?? 0, write: item.cache_write ?? 0 },
        tier: item.tier,
      })),
      experimentalOver200K: value?.context_over_200k
        ? {
            cache: {
              read: value.context_over_200k.cache_read ?? 0,
              write: value.context_over_200k.cache_write ?? 0,
            },
            input: value.context_over_200k.input,
            output: value.context_over_200k.output,
          }
        : undefined,
    }
  }

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const base: Model = {
      id: model.id,
      providerID: provider.id,
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: model.provider?.api ?? provider.api ?? "",
        npm: model.provider?.npm ?? provider.npm ?? provider.id,
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: cost(model.cost),
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        reasoning: model.reasoning,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
    }
    base.variants = ProviderTransform.reasoningVariants(model, base) ?? ProviderTransform.variants(base)
    return base
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    const models: Record<string, Model> = {}
    for (const [key, model] of Object.entries(provider.models)) {
      models[key] = fromModelsDevModel(provider, model)
      const modes = typeof model.experimental === "object" ? model.experimental.modes : undefined
      for (const [mode, options] of Object.entries(modes ?? {})) {
        const id = `${model.id}-${mode}`
        const base = fromModelsDevModel(provider, model)
        models[id] = {
          ...base,
          id,
          name: `${model.name} ${mode[0].toUpperCase()}${mode.slice(1)}`,
          cost: options.cost ? mergeDeep(base.cost, cost(options.cost)) : base.cost,
          options: modeOptions(base, options.provider?.body),
          headers: options.provider?.headers ?? base.headers,
        }
      }
    }
    return {
      id: provider.id,
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models,
    }
  }

  function modeOptions(model: Model, body: Record<string, unknown> | undefined) {
    if (!body) return model.options
    const options = Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), value]),
    )
    const reasoning = body.reasoning
    if (
      model.api.npm !== "@ai-sdk/openai" ||
      typeof reasoning !== "object" ||
      reasoning === null ||
      Array.isArray(reasoning) ||
      typeof (reasoning as Record<string, unknown>).mode !== "string"
    )
      return options
    const { reasoning: _, ...rest } = options
    return { ...rest, reasoningMode: (reasoning as Record<string, unknown>).mode }
  }

  const state = Instance.state(async () => {
    using _ = log.time("state")
    const config = await Config.get()
    const modelsDev = await ModelsDev.get()
    const database = mapValues(modelsDev, fromModelsDevProvider)

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null

    function isProviderAllowed(providerID: string): boolean {
      if (enabled && !enabled.has(providerID)) return false
      if (disabled.has(providerID)) return false
      return true
    }

    const providers: { [providerID: string]: Info } = {}
    const languages = new Map<string, LanguageModelV2>()
    const modelLoaders: {
      [providerID: string]: CustomModelLoader
    } = {}
    const sdk = new Map<number, SDK>()

    log.info("init")

    const configProviders = Object.entries(config.provider ?? {})

    // Add GitHub Copilot Enterprise provider that inherits from GitHub Copilot
    if (database["github-copilot"]) {
      const githubCopilot = database["github-copilot"]
      database["github-copilot-enterprise"] = {
        ...githubCopilot,
        id: "github-copilot-enterprise",
        name: "GitHub Copilot Enterprise",
        models: mapValues(githubCopilot.models, (model) => ({
          ...model,
          providerID: "github-copilot-enterprise",
        })),
      }
    }

    function mergeProvider(providerID: string, provider: Partial<Info>) {
      const existing = providers[providerID]
      if (existing) {
        // @ts-expect-error
        providers[providerID] = mergeDeep(existing, provider)
        return
      }
      const match = database[providerID]
      if (!match) return
      // @ts-expect-error
      providers[providerID] = mergeDeep(match, provider)
    }

    // extend database from config
    for (const [providerID, provider] of configProviders) {
      const existing = database[providerID]
      const parsed: Info = {
        id: providerID,
        name: provider.name ?? existing?.name ?? providerID,
        env: provider.env ?? existing?.env ?? [],
        options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
        source: "config",
        models: existing?.models ?? {},
      }

      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        const existingModel = parsed.models[model.id ?? modelID]
        const name = iife(() => {
          if (model.name) return model.name
          if (model.id && model.id !== modelID) return modelID
          return existingModel?.name ?? modelID
        })
        const apiID = model.id ?? existingModel?.api.id ?? modelID
        const apiNpm =
          model.provider?.npm ??
          provider.npm ??
          existingModel?.api.npm ??
          modelsDev[providerID]?.npm ??
          "@ai-sdk/openai-compatible"
        const parsedModel: Model = {
          id: modelID,
          api: {
            id: apiID,
            npm: apiNpm,
            url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
          },
          status: model.status ?? existingModel?.status ?? "active",
          name,
          providerID,
          capabilities: {
            temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
            reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
            attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
            toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
            input: {
              text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
              audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
              image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
              video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
              pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
            },
            output: {
              text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
              audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
              image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
              video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
              pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
            },
            interleaved:
              model.interleaved ??
              existingModel?.capabilities.interleaved ??
              (!existingModel && apiNpm === "@ai-sdk/openai-compatible" && apiID.includes("deepseek")
                ? { field: "reasoning_content" }
                : false),
          },
          cost: {
            input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
            output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
            cache: {
              read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
              write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
            },
          },
          options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
          limit: {
            context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
            input: model.limit?.input ?? existingModel?.limit?.input,
            output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
          },
          headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
          family: model.family ?? existingModel?.family ?? "",
          release_date: model.release_date ?? existingModel?.release_date ?? "",
          variants: {},
        }
        const defaults =
          existingModel?.api.npm === parsedModel.api.npm
            ? (existingModel.variants ?? ProviderTransform.variants(parsedModel))
            : ProviderTransform.variants(parsedModel)
        const merged = mergeDeep(defaults, model.variants ?? {})
        parsedModel.variants = Object.fromEntries(
          Object.entries(merged)
            .filter(([, value]) => !(value as Record<string, any>).disabled)
            .map(([key, value]) => {
              const { disabled: _, ...options } = value as Record<string, any>
              return [key, options]
            }),
        )
        parsed.models[modelID] = parsedModel
      }
      database[providerID] = parsed
    }

    // load env
    const env = Env.all()
    for (const [providerID, provider] of Object.entries(database)) {
      if (disabled.has(providerID)) continue
      const apiKey = provider.env.map((item) => env[item]).find(Boolean)
      if (!apiKey) continue
      mergeProvider(providerID, {
        source: "env",
        key: provider.env.length === 1 ? apiKey : undefined,
      })
    }

    // load apikeys
    for (const [providerID, provider] of Object.entries(await Auth.all())) {
      if (disabled.has(providerID)) continue
      if (provider.type === "api") {
        mergeProvider(providerID, {
          source: "api",
          key: provider.key,
        })
      }
    }

    // TODO: Load Extension-registered auth providers when implemented.
    // for (const plugin of await Plugin.list()) { ... }

    for (const [providerID, fn] of Object.entries(CUSTOM_LOADERS)) {
      if (disabled.has(providerID)) continue
      const result = await fn(database[providerID])
      if (result && (result.autoload || providers[providerID] || config.provider?.[providerID])) {
        if (result.getModel) modelLoaders[providerID] = result.getModel
        mergeProvider(providerID, {
          source: "custom",
          options: result.options,
        })
      }
    }

    // load config
    for (const [providerID, provider] of configProviders) {
      const partial: Partial<Info> = { source: "config" }
      if (provider.env) partial.env = provider.env
      if (provider.name) partial.name = provider.name
      if (provider.options) partial.options = provider.options
      mergeProvider(providerID, partial)
    }

    for (const [providerID, provider] of Object.entries(providers)) {
      if (!isProviderAllowed(providerID)) {
        delete providers[providerID]
        continue
      }

      if (providerID === "github-copilot" || providerID === "github-copilot-enterprise") {
        provider.models = mapValues(provider.models, (model) => ({
          ...model,
          api: {
            ...model.api,
            npm: "@ai-sdk/github-copilot",
          },
        }))
      }

      const configProvider = config.provider?.[providerID]
      const auth = await Auth.get(providerID)

      for (const [modelID, model] of Object.entries(provider.models)) {
        model.api.id = model.api.id ?? model.id ?? modelID
        if (model.variants === undefined) model.variants = ProviderTransform.variants(model)
        if (modelID === "gpt-5-chat-latest" || (providerID === "openrouter" && modelID === "openai/gpt-5-chat"))
          delete provider.models[modelID]
        if (model.status === "alpha" && !Flag.REDSUN_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
        if (
          (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
          (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
        )
          delete provider.models[modelID]
        if (providerID === "openai" && auth?.type === "oauth") {
          if (!OpenAICodexOAuth.supportsModel(model)) {
            delete provider.models[modelID]
            continue
          }
          model.limit = OpenAICodexOAuth.contextLimits(model)
          model.cost = {
            input: 0,
            output: 0,
            cache: {
              read: 0,
              write: 0,
            },
          }
        }
      }

      if (Object.keys(provider.models).length === 0) {
        delete providers[providerID]
        continue
      }

      log.info("found", { providerID })
    }

    return {
      models: languages,
      providers,
      customProviderBases: new Map<string, Info | undefined>(),
      sdk,
      modelLoaders,
    }
  })

  export async function list() {
    return state().then((state) => state.providers)
  }

  async function getSDK(model: Model) {
    try {
      using _ = log.time("getSDK", {
        providerID: model.providerID,
      })
      const s = await state()
      const provider = s.providers[model.providerID]
      const options = { ...provider.options }

      if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
        options["includeUsage"] = true
      }

      if (!options["baseURL"]) options["baseURL"] = model.api.url
      if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
      if (model.headers)
        options["headers"] = {
          ...options["headers"],
          ...model.headers,
        }

      const key = Bun.hash.xxHash32(JSON.stringify({ providerID: model.providerID, npm: model.api.npm, options }))
      const existing = s.sdk.get(key)
      if (existing) return existing

      const customFetch = options["fetch"]

      options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
        // Preserve custom fetch if it exists, wrap it with timeout logic
        const fetchFn = customFetch ?? fetch
        const opts = init ?? {}

        if (options["timeout"] !== undefined && options["timeout"] !== null) {
          const signals: AbortSignal[] = []
          if (opts.signal) signals.push(opts.signal)
          if (options["timeout"] !== false) signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

          opts.signal = combined
        }

        return fetchFn(input, {
          ...opts,
          // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
          timeout: false,
        })
      }

      // Special case: google-vertex-anthropic uses a subpath import
      const bundledKey =
        model.providerID === "google-vertex-anthropic" ? "@ai-sdk/google-vertex/anthropic" : model.api.npm
      const bundledFn = BUNDLED_PROVIDERS[bundledKey]
      if (bundledFn) {
        log.info("using bundled provider", { providerID: model.providerID, pkg: bundledKey })
        const loaded = bundledFn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded as SDK
      }

      if (await Config.isProjectProviderModule(model.providerID, model.api.npm)) {
        const { ToolRegistry } = await import("../tool/registry")
        if (!(await ToolRegistry.getRunner()).projectTrusted) {
          throw new Error(`Project provider module requires a trusted project: ${model.providerID}`)
        }
      }

      let installedPath: string
      if (!model.api.npm.startsWith("file://")) {
        installedPath = await BunProc.install(model.api.npm, "latest")
      } else {
        log.info("loading local provider", { pkg: model.api.npm })
        installedPath = model.api.npm
      }

      const mod = await import(installedPath)

      const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
      const loaded = fn({
        name: model.providerID,
        ...options,
      })
      s.sdk.set(key, loaded)
      return loaded as SDK
    } catch (e) {
      throw new InitError({ providerID: model.providerID }, { cause: e })
    }
  }

  export async function getProvider(providerID: string) {
    return state().then((s) => s.providers[providerID])
  }

  export async function getModel(providerID: string, modelID: string) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) {
      const availableProviders = Object.keys(s.providers)
      const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }

    const info = provider.models[modelID]
    if (!info) {
      const availableModels = Object.keys(provider.models)
      const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
      const suggestions = matches.map((m) => m.target)
      throw new ModelNotFoundError({ providerID, modelID, suggestions })
    }
    return info
  }

  export async function getLanguage(model: Model): Promise<LanguageModelV2> {
    const s = await state()
    const key = `${model.providerID}/${model.id}`
    if (s.models.has(key)) return s.models.get(key)!

    const provider = s.providers[model.providerID]
    const sdk = await getSDK(model)

    try {
      const language = s.modelLoaders[model.providerID]
        ? await s.modelLoaders[model.providerID](sdk, model.api.id, provider.options, model)
        : sdk.languageModel(model.api.id)
      s.models.set(key, language)
      return language
    } catch (e) {
      if (e instanceof NoSuchModelError)
        throw new ModelNotFoundError(
          {
            modelID: model.id,
            providerID: model.providerID,
          },
          { cause: e },
        )
      throw e
    }
  }

  export async function closest(providerID: string, query: string[]) {
    const s = await state()
    const provider = s.providers[providerID]
    if (!provider) return undefined
    for (const item of query) {
      for (const modelID of Object.keys(provider.models)) {
        if (modelID.includes(item))
          return {
            providerID,
            modelID,
          }
      }
    }
  }

  export async function getSmallModel(providerID: string) {
    const cfg = await Config.get()

    if (cfg.small_model) {
      const parsed = parseModel(cfg.small_model)
      return getModel(parsed.providerID, parsed.modelID).catch((error) => {
        if (error instanceof ModelNotFoundError) return undefined
        throw error
      })
    }

    const provider = await state().then((state) => state.providers[providerID])
    if (!provider) return undefined

    // Azure deployments do not reliably expose enough catalog metadata to infer a valid deployment name.
    if (providerID === "azure" || providerID === "azure-cognitive-services") return undefined

    const priority = providerID.startsWith("opencode")
      ? ["gpt-nano"]
      : providerID.startsWith("github-copilot")
        ? ["gpt-mini", ...smallModelFamilyPriority]
        : smallModelFamilyPriority
    const models = sortBy(
      Object.values(provider.models),
      [(model) => model.release_date, "desc"],
      [(model) => model.id, "desc"],
    )
    for (const family of priority) {
      const candidates = models.filter((model) => model.family === family)
      if (providerID === "amazon-bedrock") {
        const crossRegionPrefixes = ["global.", "us.", "eu."]
        const globalMatch = candidates.find((model) => model.id.startsWith("global."))
        if (globalMatch) return globalMatch

        const region = provider.options?.region
        if (typeof region === "string") {
          const regionPrefix = region.split("-")[0]
          if (regionPrefix === "us" || regionPrefix === "eu") {
            const regionalMatch = candidates.find((model) => model.id.startsWith(`${regionPrefix}.`))
            if (regionalMatch) return regionalMatch
          }
        }

        const unprefixed = candidates.find((model) => !crossRegionPrefixes.some((prefix) => model.id.startsWith(prefix)))
        if (unprefixed) return unprefixed
        continue
      }
      if (candidates[0]) return candidates[0]
    }

    return undefined
  }

  const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
  const smallModelFamilyPriority = ["gemini-flash", "gpt-nano", "claude-haiku"]
  export function sort(models: Model[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export async function defaultModel() {
    const cfg = await Config.get()
    if (cfg.model) return parseModel(cfg.model)

    const provider = await list()
      .then((val) => Object.values(val))
      .then((x) => {
        const configured = Object.keys(cfg.provider ?? {})
        return x.find((p) => configured.length === 0 || configured.includes(p.id))
      })
    if (!provider) throw new NoProvidersError({})
    const [model] = sort(Object.values(provider.models))
    if (!model) throw new NoModelsError({ providerID: provider.id })
    return {
      providerID: provider.id,
      modelID: model.id,
    }
  }

  export type ModelRef = { providerID: string; modelID: string; variant?: string }

  export function parseModel(model: string): ModelRef {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: providerID,
      modelID: rest.join("/"),
    }
  }

  export async function registerProvider(name: string, config: {
    name?: string
    baseUrl?: string
    apiKey?: string
    api?: string
    models?: Array<{
      id: string
      name: string
      api?: string
      reasoning: boolean
      input: ("text" | "image")[]
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
      contextWindow: number
      maxTokens: number
      headers?: Record<string, string>
    }>
    headers?: Record<string, string>
  }) {
    const s = await state()
    const apiNpm = config.api
      ? `@ai-sdk/${config.api.includes("anthropic") ? "anthropic" : config.api.includes("google") ? "google" : config.api.includes("openai-compatible") ? "openai-compatible" : "openai"}`
      : undefined

    const models: Record<string, Model> = {}
    if (config.models) {
      for (const m of config.models) {
        const model: Model = {
          id: m.id,
          providerID: name,
          api: {
            id: m.api ?? m.id,
            npm: apiNpm ?? "@ai-sdk/openai-compatible",
            url: config.baseUrl ?? (config.api && config.api.includes("anthropic") ? "https://api.anthropic.com" : ""),
          },
          status: "active",
          name: m.name,
          capabilities: {
            temperature: true,
            reasoning: m.reasoning,
            attachment: m.input.includes("image"),
            toolcall: true,
            input: {
              text: m.input.includes("text"),
              audio: false,
              image: m.input.includes("image"),
              video: false,
              pdf: false,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: false,
          },
          cost: {
            input: m.cost.input,
            output: m.cost.output,
            cache: {
              read: m.cost.cacheRead,
              write: m.cost.cacheWrite,
            },
          },
          limit: {
            context: m.contextWindow,
            output: m.maxTokens,
          },
          options: m.headers ?? {},
          headers: m.headers ?? {},
          family: "",
          release_date: "",
        }
        models[m.id] = model
      }
    }

    const provider: Info = {
      id: name,
      name: config.name ?? name,
      source: "custom",
      env: config.apiKey ? [] : [],
      key: config.apiKey,
      options: config.headers ?? {},
      models,
    }

    if (!s.customProviderBases.has(name)) s.customProviderBases.set(name, s.providers[name])
    s.providers[name] = provider
    log.info("registered provider", { name, modelCount: Object.keys(models).length })
  }

  export async function unregisterProvider(name: string) {
    const s = await state()
    const previous = s.customProviderBases.get(name)
    if (s.customProviderBases.has(name)) {
      if (previous) s.providers[name] = previous
      else delete s.providers[name]
      s.customProviderBases.delete(name)
    } else {
      delete s.providers[name]
    }
    // Clear cached language models
    for (const key of s.models.keys()) {
      if (key.startsWith(name + "/")) {
        s.models.delete(key)
      }
    }
    log.info("unregistered provider", { name })
  }

  const _ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: z.string(),
      modelID: z.string(),
      suggestions: z.array(z.string()).optional(),
    }),
  )
  export class ModelNotFoundError extends _ModelNotFoundError {
    override get message() {
      const data = this.data as { providerID: string; modelID: string; suggestions?: string[] }
      const suggestions = data.suggestions?.length ? ` Did you mean: ${data.suggestions.join(", ")}?` : ""
      return `Model not found: ${data.providerID}/${data.modelID}.${suggestions}`
    }
  }

  const _InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: z.string(),
    }),
  )
  export class InitError extends _InitError {
    override get message() {
      const data = this.data as { providerID: string }
      return `Failed to initialize provider: ${data.providerID}`
    }
  }

  const _NoProvidersError = NamedError.create("ProviderNoProvidersError", z.object({}))
  export class NoProvidersError extends _NoProvidersError {
    override get message() {
      return "No providers are available"
    }
  }

  const _NoModelsError = NamedError.create(
    "ProviderNoModelsError",
    z.object({
      providerID: z.string(),
    }),
  )
  export class NoModelsError extends _NoModelsError {
    override get message() {
      return `No models are available for provider: ${this.data.providerID}`
    }
  }
}
