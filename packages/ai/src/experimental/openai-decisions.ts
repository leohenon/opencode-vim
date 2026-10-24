import { Effect, Schema } from "effect"
import type { HttpClientResponse } from "effect/http"
import {
  EvaluationModel,
  EvaluationResponse,
  EvaluationRounding,
  type EvaluationAnswer,
  type EvaluationInput,
  type EvaluationRequestFor,
} from "./evaluation.js"
import { OpenResponses } from "../protocols/open-responses.js"
import { Endpoint } from "../route/endpoint.js"
import { MediaProtocol } from "../route/media-protocol.js"
import { MediaRoute } from "../route/media.js"
import { ModelID, mergeJsonRecords, type OpenString } from "../schema/index.js"
import { encodeJson } from "../utils/json.js"

const route = MediaProtocol.identity({ id: "openai-decisions", name: "OpenAI Decisions", provider: "openai" })
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = "/decisions"

/** Native body fields, sent as given. */
export type OpenAIDecisionOptions = {
  readonly prompt_cache_key?: string
  readonly prompt_cache_options?: Readonly<{ mode?: OpenString<"implicit" | "explicit">; ttl?: OpenString<"30m"> }>
  readonly safety_identifier?: string
} & Record<string, unknown>

type Request = EvaluationRequestFor<OpenAIDecisionOptions>

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("predicate"), name: Schema.String, probability: Probability }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    name: Schema.String,
    choice: Schema.String,
    probabilities: Schema.Array(Schema.Struct({ value: Schema.String, probability: Probability })),
    confidence: Schema.optional(Probability),
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    name: Schema.String,
    score: Schema.Number,
    probabilities: Schema.Array(Schema.Struct({ value: Schema.Int, probability: Probability })),
    confidence: Schema.optional(Probability),
  }),
  Schema.Struct({ type: Schema.Literal("refusal"), name: Schema.String }),
])
const Response = Schema.Struct({
  model: Schema.String,
  answers: Schema.Array(Answer),
  usage: Schema.optional(OpenResponses.OpenResponsesUsage),
})

const fromRequest = Effect.fn("OpenAIDecisions.fromRequest")(function* (request: Request) {
  const criteria = Object.entries(request.questions).flatMap(([name, question]) =>
    question.type === "boolean" && question.criteria !== undefined ? [name] : [],
  )
  if (criteria.length > 0)
    return yield* route.unsupported(
      "evaluation.criteria",
      `${route.name} boolean questions take instructions only; remove criteria from ${criteria.join(", ")}`,
    )
  return MediaProtocol.json({
    ...mergeJsonRecords(request.options, request.http?.body),
    model: request.model.id,
    input: typeof request.state === "string" ? request.state : [{ role: "user", content: json(request.state) }],
    questions: Object.entries(request.questions).map(([name, question]) => {
      const instructions = typeof question.instructions === "string" ? question.instructions : json(question.instructions)
      if (question.type === "boolean") return { type: "predicate", name, instructions }
      if (question.type === "choice")
        return {
          type: "choice",
          name,
          instructions,
          choices: Object.entries(question.criteria).map(([value, description]) => ({
            value,
            ...(description === null ? {} : { description: text(description) }),
          })),
        }
      return {
        type: "score",
        name,
        instructions,
        levels: question.criteria.map((level, index) =>
          typeof level === "string"
            ? { label: level }
            : { label: String(index), ...(level === null ? {} : { description: text(level) }) },
        ),
      }
    }),
  })
})

const json = (data: EvaluationInput) => [{ type: "input_json", data }]
const text = (value: EvaluationInput) => (typeof value === "string" ? value : encodeJson(value))

const decodeDocument = route.decodeJson(Response)

const decodeResponse = Effect.fn("OpenAIDecisions.decodeResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const output = yield* decodeDocument(response)
  const refused = output.value.answers.flatMap((answer) => (answer.type === "refusal" ? [answer.name] : []))
  if (refused.length > 0) return yield* output.contentPolicy(`${route.name} refused to answer ${refused.join(", ")}`)
  return new EvaluationResponse({
    model: ModelID.make(output.value.model),
    answers: Object.fromEntries(
      output.value.answers.flatMap((answer): Array<[string, EvaluationAnswer]> => {
        if (answer.type === "refusal") return []
        if (answer.type === "predicate") return [[answer.name, { type: "boolean", probability: answer.probability }]]
        const probabilities = Object.fromEntries(answer.probabilities.map((item) => [item.value, item.probability]))
        const confidence = answer.confidence === undefined ? {} : { confidence: answer.confidence }
        if (answer.type === "choice")
          return [[answer.name, { type: "choice", choice: answer.choice, probabilities, ...confidence }]]
        return [[answer.name, { type: "score", score: answer.score, probabilities, ...confidence }]]
      }),
    ),
    usage: OpenResponses.mapUsage(output.value.usage, "openai"),
    rounding: new EvaluationRounding({ probabilityDecimals: 2, scoreDecimals: 2 }),
  })
})

export const protocol = MediaProtocol.inline<Request, EvaluationResponse>(route, {
  body: { from: fromRequest },
  response: { decode: decodeResponse },
})

export const model = (input: MediaRoute.ModelInput) => {
  const composed = MediaRoute.inline({
    protocol,
    endpoint: Endpoint.path<MediaProtocol.Body, Request>(PATH, { baseURL: input.baseURL ?? DEFAULT_BASE_URL }),
    auth: input.auth,
    headers: input.headers,
  })
  return EvaluationModel.make<OpenAIDecisionOptions>({
    id: input.id,
    provider: protocol.provider,
    http: input.http,
    route: { id: composed.id, evaluate: composed.generate },
  })
}

export const OpenAIDecisions = {
  protocol,
  model,
} as const
