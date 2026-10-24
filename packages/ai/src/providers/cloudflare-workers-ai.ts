import type { ProviderPackage } from "../provider-package.js"
import { CloudflareRunEvaluation } from "../experimental/cloudflare-run-evaluation.js"
import { EvaluationRounding } from "../experimental/evaluation.js"
import { CloudflareWorkersAIImages } from "../protocols/cloudflare-workers-ai-images.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { AuthOptions, type AtLeastOne, type ProviderAuthOption } from "../route/auth-options.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { MediaRoute } from "../route/media.js"
import { HttpOptions, ProviderConfigurationError, ProviderID, type ModelID } from "../schema/index.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("cloudflare-workers-ai")
export const authEnvVars = ["CLOUDFLARE_API_KEY", "CLOUDFLARE_WORKERS_AI_TOKEN", "CLOUDFLARE_API_TOKEN"] as const

type WorkersAIURL = AtLeastOne<{
  readonly accountId: string
  readonly baseURL: string
}>

export type LanguageModelOptions = WorkersAIURL &
  Omit<RouteDefaultsInput, "providerOptions"> &
  ProviderAuthOption<"optional"> & {
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput &
  WorkersAIURL & {
    readonly apiKey?: string
  }

export type { CloudflareWorkersAIImageOptions } from "../protocols/cloudflare-workers-ai-images.js"

export const baseURL = (input: WorkersAIURL) => {
  if (input.baseURL) return input.baseURL
  if (!input.accountId)
    throw new ProviderConfigurationError({
      provider: id,
      message: "CloudflareWorkersAI.configure requires accountId unless baseURL is supplied",
    })
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/ai/v1`
}

/** The Run API (`/ai/run`) next to the OpenAI-compatible `/ai/v1` base. */
export const runBaseURL = (input: WorkersAIURL) => {
  const url = Endpoint.trimBaseUrl(baseURL(input))
  if (!url.endsWith("/ai/v1"))
    throw new ProviderConfigurationError({
      provider: id,
      message: "CloudflareWorkersAI needs accountId or a baseURL ending in /ai/v1 to derive the Run API base",
    })
  return `${url.slice(0, -"/v1".length)}/run`
}

export const route = Route.make({
  id: "cloudflare-workers-ai",
  provider: id,
  providerMetadataKey: "cloudflare-workers-ai",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions"),
  framing: OpenAIChat.framing,
})

export const routes = [route]

const clefRounding = new EvaluationRounding({ probabilityDecimals: 4, scoreDecimals: 4 })

export const configure = (input: LanguageModelOptions) => {
  const { accountId: _accountId, apiKey: _apiKey, auth: _auth, baseURL: _baseURL, ...defaults } = input
  const auth = AuthOptions.bearer(input, authEnvVars)
  const configured = route.with({ ...defaults, endpoint: { baseURL: baseURL(input) }, auth })
  const evaluation = (modelID: string | ModelID) =>
    CloudflareRunEvaluation.model({
      id: modelID,
      provider: id,
      auth,
      baseURL: runBaseURL(input),
      headers: input.headers,
      http: HttpOptions.make(input.http),
      rounding: clefRounding,
    })
  return {
    id,
    model: (modelID: string | ModelID) => configured.model<OpenAIProviderOptionsInput>({ id: modelID }),
    experimental: { evaluation },
    image: (modelID: string | ModelID) =>
      CloudflareWorkersAIImages.model({
        ...MediaRoute.deployment({ ...input, baseURL: runBaseURL(input) }, auth),
        id: modelID,
      }),
    configure,
  }
}

export const provider = { id, configure }

export const model: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (modelID, settings) => {
  const { accountId: _, apiKey, baseURL: _url, body, headers, ...providerOptions } = settings
  return configure({
    apiKey,
    baseURL: baseURL(settings),
    headers,
    http: body === undefined ? undefined : { body },
    providerOptions,
  }).model(modelID)
}

export * as CloudflareWorkersAI from "./cloudflare-workers-ai.js"
