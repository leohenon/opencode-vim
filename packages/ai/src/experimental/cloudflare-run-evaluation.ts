import { Effect, Schema } from "effect"
import {
  EvaluationModel,
  type EvaluationRequestFor,
  type EvaluationResponse,
  type EvaluationRounding,
} from "./evaluation.js"
import { SystemOne } from "./system-one.js"
import { Endpoint } from "../route/endpoint.js"
import { MediaProtocol } from "../route/media-protocol.js"
import { MediaRoute } from "../route/media.js"
import type { ProviderID } from "../schema/index.js"

// Workers AI models answer with the System One response; third-party models such as TypeSafe Jev wrap it in a
// completed run record.
const Envelope = Schema.Struct({
  result: Schema.Union([
    SystemOne.Response,
    Schema.Struct({ state: Schema.Literal("Completed"), result: SystemOne.Response }),
  ]),
})

export interface ModelInput extends MediaRoute.ModelInput {
  /** Also the provider metadata key. */
  readonly provider: ProviderID
  /** The Run API base, `.../client/v4/accounts/{account}/ai/run`. */
  readonly baseURL: string
  readonly rounding?: EvaluationRounding
}

/** Posts `{ model, input }` to Cloudflare's `/ai/run` with the System One request body as `input`. */
export const model = (input: ModelInput) => {
  const route = MediaProtocol.identity({
    id: "cloudflare-run-evaluation",
    name: "Cloudflare Run",
    provider: input.provider,
  })
  const decodeEnvelope = route.decodeJson(Envelope)
  const composed = MediaRoute.inline({
    protocol: MediaProtocol.inline<EvaluationRequestFor, EvaluationResponse>(route, {
      body: {
        from: (request) =>
          SystemOne.encodeInput(request).pipe(
            Effect.map((body) => MediaProtocol.json({ model: request.model.id, input: body })),
          ),
      },
      response: {
        decode: (response) =>
          decodeEnvelope(response).pipe(
            Effect.map((output) =>
              SystemOne.toResponse(
                "answers" in output.value.result ? output.value.result : output.value.result.result,
                input.provider,
                input.rounding,
              ),
            ),
          ),
      },
    }),
    endpoint: Endpoint.path<MediaProtocol.Body, EvaluationRequestFor>("", { baseURL: input.baseURL }),
    auth: input.auth,
    headers: input.headers,
  })
  return EvaluationModel.make({
    id: input.id,
    provider: input.provider,
    http: input.http,
    route: { id: composed.id, evaluate: composed.generate },
  })
}

export const CloudflareRunEvaluation = { model } as const
