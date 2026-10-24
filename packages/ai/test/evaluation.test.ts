import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientRequest } from "effect/http"
import { Evaluation, EvaluationClient } from "../src/experimental.js"
import { CloudflareWorkersAI, OpenAI, OpenCode, OpenRouter, TypeSafeAI, VercelAIGateway } from "../src/providers.js"
import { it } from "./lib/effect.js"
import { dynamicResponse } from "./lib/http.js"

describe("experimental Evaluation", () => {
  it.effect("evaluates typed questions through System One", () =>
    Effect.gen(function* () {
      const response = yield* Evaluation.run({
        model: TypeSafeAI.configure({
          apiKey: "test",
          baseURL: "https://typesafe.test/v1/",
          headers: { "x-default": "yes" },
          http: { body: { deployment: "test" }, query: { api: "v1" } },
        }).experimental.evaluation("jev-latest"),
        state: { ticket: "Please refund the duplicate charge." },
        questions: {
          department: {
            type: "choice",
            instructions: "Which team should handle this?",
            criteria: { billing: "Payments and refunds", technical: "Bugs and outages" },
          },
          urgency: {
            type: "score",
            instructions: "How urgent is this?",
            criteria: ["Can wait", "Needs attention", "Blocking"],
          },
          refund: { type: "boolean", instructions: "Is the customer asking for a refund?" },
        },
        options: { trace: { enabled: true } },
        http: { body: { request_metadata: "value" }, headers: { "x-request": "yes" }, query: { trace: "1" } },
      })

      expect(response.model).toBe("jev-1.13.0")
      expect(response.answers.department).toEqual({
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.9, technical: 0.1 },
        confidence: 0.8,
      })
      expect(response.answers.urgency).toEqual({
        type: "score",
        score: 1.2,
        probabilities: { "0": 0, "1": 0.8, "2": 0.2 },
        confidence: 0.6,
      })
      expect(response.answers.refund).toEqual({ type: "boolean", probability: 0.97 })
      expect(response.usage?.totalTokens).toBe(36)
      expect(response.providerMetadata).toEqual({
        typesafe: {
          legend: { urgency: { "0": "Can wait", "1": "Needs attention", "2": "Blocking" } },
        },
      })
    }).pipe(
      Effect.provide(
        EvaluationClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                expect(request.url).toBe("https://typesafe.test/v1/systemone?api=v1&trace=1")
                expect(request.headers.get("authorization")).toBe("Bearer test")
                expect(request.headers.get("x-default")).toBe("yes")
                expect(request.headers.get("x-request")).toBe("yes")
                expect(JSON.parse(input.text)).toEqual({
                  deployment: "test",
                  request_metadata: "value",
                  trace: { enabled: true },
                  model: "jev-latest",
                  state: { ticket: "Please refund the duplicate charge." },
                  questions: {
                    department: {
                      type: "choice",
                      instructions: "Which team should handle this?",
                      criteria: { billing: "Payments and refunds", technical: "Bugs and outages" },
                    },
                    urgency: {
                      type: "score",
                      instructions: "How urgent is this?",
                      criteria: ["Can wait", "Needs attention", "Blocking"],
                    },
                    refund: { type: "noul", instructions: "Is the customer asking for a refund?" },
                  },
                })
                return input.respond(
                  JSON.stringify({
                    model: "jev-1.13.0",
                    answers: {
                      department: {
                        type: "choice",
                        choice: "billing",
                        probabilities: { billing: 0.9, technical: 0.1 },
                        confidence: 0.8,
                      },
                      urgency: {
                        type: "score",
                        score: 1.2,
                        probabilities: { "0": 0, "1": 0.8, "2": 0.2 },
                        legend: { "0": "Can wait", "1": "Needs attention", "2": "Blocking" },
                        confidence: 0.6,
                      },
                      refund: { type: "noul", noul: 0.97 },
                    },
                    usage: { input_tokens: 30, output_tokens: 6 },
                  }),
                  { headers: { "content-type": "application/json" } },
                )
              }),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("configures the OpenCode System One endpoint", () =>
    Evaluation.run({
      model: OpenCode.configure({
        apiKey: "opencode-key",
        baseURL: "https://opencode.test/v1",
      }).experimental.evaluation("jev-1.13"),
      state: "hello",
      questions: { greeting: { type: "boolean", instructions: "Is this a greeting?" } },
    }).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          expect(response.answers.greeting.probability).toBe(0.99)
          expect(response.usage?.providerMetadata).toEqual({
            opencode: { input_tokens: 10, output_tokens: 2 },
          })
        }),
      ),
      Effect.provide(
        EvaluationClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) => {
              expect(input.request.url).toBe("https://opencode.test/v1/systemone")
              expect(input.request.headers.authorization).toBe("Bearer opencode-key")
              return Effect.succeed(
                input.respond(
                  JSON.stringify({
                    model: "jev-1.13.0",
                    answers: { greeting: { type: "noul", noul: 0.99 } },
                    usage: { input_tokens: 10, output_tokens: 2 },
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
              )
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("evaluates through OpenRouter System One", () =>
    Evaluation.run({
      model: OpenRouter.configure({
        apiKey: "openrouter-key",
        baseURL: "https://openrouter.test/api/v1",
      }).experimental.evaluation("typesafe/jev-1.13"),
      state: "refund",
      questions: { refund: { type: "boolean", instructions: "Is a refund requested?" } },
      options: { user: "user-1", session_id: "session-1" },
    }).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          expect(response.answers.refund.probability).toBe(0.98)
          expect(response.providerMetadata?.openrouter).toMatchObject({ responseId: "gen-1", provider: "TypeSafe" })
          expect(response.usage?.providerMetadata?.openrouter).toEqual({
            input_tokens: 10,
            output_tokens: 2,
            cost: 0.0001,
          })
        }),
      ),
      Effect.provide(
        EvaluationClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) => {
              expect(input.request.url).toBe("https://openrouter.test/api/v1/systemone")
              expect(input.request.headers.authorization).toBe("Bearer openrouter-key")
              expect(JSON.parse(input.text)).toMatchObject({
                model: "typesafe/jev-1.13",
                user: "user-1",
                session_id: "session-1",
                questions: { refund: { type: "noul" } },
              })
              return Effect.succeed(
                input.respond(
                  JSON.stringify({
                    id: "gen-1",
                    model: "typesafe/jev-1.13-20260917",
                    provider: "TypeSafe",
                    answers: { refund: { type: "noul", noul: 0.98 } },
                    usage: { input_tokens: 10, output_tokens: 2, cost: 0.0001 },
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
              )
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("evaluates through Vercel AI Gateway", () =>
    Evaluation.run({
      model: VercelAIGateway.configure({
        apiKey: "gateway-key",
        baseURL: "https://gateway.test/v1/",
      }).experimental.evaluation("typesafe-ai/jev"),
      state: "refund",
      questions: { refund: { type: "boolean", instructions: "Is a refund requested?" } },
      options: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
    }).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          expect(response.answers.refund.probability).toBe(0.98)
          expect(response.usage?.totalTokens).toBe(12)
          expect(response.providerMetadata?.gateway).toMatchObject({ generationId: "gen-1", cost: "0.0001" })
        }),
      ),
      Effect.provide(
        EvaluationClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) => {
              expect(input.request.url).toBe("https://gateway.test/v1/evaluate")
              expect(input.request.headers.authorization).toBe("Bearer gateway-key")
              expect(JSON.parse(input.text)).toEqual({
                model: "typesafe-ai/jev",
                state: "refund",
                questions: { refund: { type: "boolean", instructions: "Is a refund requested?" } },
                providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
              })
              return Effect.succeed(
                input.respond(
                  JSON.stringify({
                    model: "typesafe-ai/jev",
                    answers: { refund: { type: "boolean", probability: 0.98 } },
                    usage: { inputTokens: 10, outputTokens: 2 },
                    providerMetadata: { gateway: { generationId: "gen-1", cost: "0.0001" } },
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
              )
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("evaluates through OpenAI Decisions", () =>
    Evaluation.run({
      model: OpenAI.configure({
        apiKey: "openai-key",
        baseURL: "https://openai.test/v1",
        queryParams: { api: "v1" },
      }).experimental.evaluation("gpt-6-luna"),
      state: { ticket: "Please refund the duplicate charge." },
      questions: {
        department: {
          type: "choice",
          instructions: { question: "Which team should handle this?" },
          criteria: { billing: "Payments and refunds", technical: { examples: ["outage"] }, sales: null },
        },
        urgency: { type: "score", instructions: "How urgent is this?", criteria: ["Can wait", { level: "now" }, null] },
        refund: { type: "boolean", instructions: "Is the customer asking for a refund?" },
      },
      options: { safety_identifier: "user-1" },
    }).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          expect(response.model).toBe("gpt-6-luna")
          expect(response.answers.department).toEqual({
            type: "choice",
            choice: "billing",
            probabilities: { billing: 0.9, technical: 0.1, sales: 0 },
            confidence: 0.8,
          })
          expect(response.answers.urgency).toEqual({
            type: "score",
            score: 1.1,
            probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 },
            confidence: 0.4,
          })
          expect(response.answers.refund).toEqual({ type: "boolean", probability: 0.97 })
        }),
      ),
      Effect.provide(
        EvaluationClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) => {
              expect(input.request.url).toBe("https://openai.test/v1/decisions?api=v1")
              expect(input.request.headers.authorization).toBe("Bearer openai-key")
              expect(JSON.parse(input.text)).toEqual({
                safety_identifier: "user-1",
                model: "gpt-6-luna",
                input: [
                  {
                    role: "user",
                    content: [{ type: "input_json", data: { ticket: "Please refund the duplicate charge." } }],
                  },
                ],
                questions: [
                  {
                    type: "choice",
                    name: "department",
                    instructions: [{ type: "input_json", data: { question: "Which team should handle this?" } }],
                    choices: [
                      { value: "billing", description: "Payments and refunds" },
                      { value: "technical", description: '{"examples":["outage"]}' },
                      { value: "sales" },
                    ],
                  },
                  {
                    type: "score",
                    name: "urgency",
                    instructions: "How urgent is this?",
                    levels: [{ label: "Can wait" }, { label: "1", description: '{"level":"now"}' }, { label: "2" }],
                  },
                  { type: "predicate", name: "refund", instructions: "Is the customer asking for a refund?" },
                ],
              })
              return Effect.succeed(
                input.respond(
                  JSON.stringify({
                    model: "gpt-6-luna",
                    answers: [
                      {
                        type: "choice",
                        name: "department",
                        choice: "billing",
                        probabilities: [
                          { value: "billing", probability: 0.9 },
                          { value: "technical", probability: 0.1 },
                          { value: "sales", probability: 0 },
                        ],
                        confidence: 0.8,
                      },
                      {
                        type: "score",
                        name: "urgency",
                        score: 1.1,
                        probabilities: [
                          { value: 0, label: "Can wait", probability: 0.1 },
                          { value: 1, label: "1", probability: 0.7 },
                          { value: 2, label: "2", probability: 0.2 },
                        ],
                        confidence: 0.4,
                      },
                      { type: "predicate", name: "refund", probability: 0.97 },
                    ],
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
              )
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("fails OpenAI Decisions refusals as content policy errors", () =>
    Evaluation.run({
      model: OpenAI.configure({ apiKey: "openai-key" }).experimental.evaluation("gpt-6-luna"),
      state: "hello",
      questions: {
        greeting: { type: "boolean", instructions: "Is this a greeting?" },
        unsafe: { type: "boolean", instructions: "Something the model declines" },
      },
    }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.reason._tag).toBe("ContentPolicy")
          expect(error.reason.message).toContain("unsafe")
        }),
      ),
      Effect.provide(
        EvaluationClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.succeed(
                input.respond(
                  JSON.stringify({
                    model: "gpt-6-luna",
                    answers: [
                      { type: "predicate", name: "greeting", probability: 0.99 },
                      { type: "refusal", name: "unsafe" },
                    ],
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("rejects boolean criteria for OpenAI Decisions before network I/O", () =>
    Effect.gen(function* () {
      const error = yield* Evaluation.run({
        model: OpenAI.configure({ apiKey: "openai-key" }).experimental.evaluation("gpt-6-luna"),
        state: "hello",
        questions: {
          greeting: { type: "boolean", instructions: "Is this a greeting?", criteria: { true: "Says hello" } },
        },
      }).pipe(Effect.flip)
      expect(error.reason._tag).toBe("UnsupportedOperation")
      expect(error.reason.message).toContain("greeting")
    }).pipe(
      Effect.provide(
        EvaluationClient.layer.pipe(
          Layer.provide(dynamicResponse(() => Effect.die("invalid evaluation reached the network"))),
        ),
      ),
    ),
  )

  it.effect("surfaces Cloudflare Run errors", () =>
    Evaluation.run({
      model: CloudflareWorkersAI.configure({
        accountId: "test-account",
        apiKey: "cloudflare-key",
      }).experimental.evaluation("@cf/cloudflare/clef"),
      state: "refund",
      questions: { refund: { type: "boolean", instructions: "Is a refund requested?" } },
    }).pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => {
          expect(error.reason._tag).toBe("InvalidRequest")
          expect(error.message).toContain("At least one question is required")
        }),
      ),
      Effect.provide(
        EvaluationClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) => {
              expect(input.request.url).toBe("https://api.cloudflare.com/client/v4/accounts/test-account/ai/run")
              expect(input.request.headers.authorization).toBe("Bearer cloudflare-key")
              expect(JSON.parse(input.text)).toEqual({
                model: "@cf/cloudflare/clef",
                input: {
                  state: "refund",
                  questions: { refund: { type: "noul", instructions: "Is a refund requested?" } },
                },
              })
              return Effect.succeed(
                input.respond(
                  JSON.stringify({
                    errors: [
                      {
                        message:
                          "Model execution failed (User Input Error): Validation error at questions: At least one question is required",
                        code: 7003,
                      },
                    ],
                    success: false,
                    result: {},
                    messages: [],
                  }),
                  { status: 400, headers: { "content-type": "application/json" } },
                ),
              )
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("rejects answers that do not match their questions", () =>
    Evaluation.run({
      model: VercelAIGateway.configure({
        apiKey: "gateway-key",
        baseURL: "https://gateway.test/v1",
      }).experimental.evaluation("typesafe-ai/jev"),
      state: "refund",
      questions: { refund: { type: "boolean", instructions: "Is a refund requested?" } },
    }).pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => expect(error.reason._tag).toBe("InvalidProviderOutput"))),
      Effect.provide(
        EvaluationClient.layer.pipe(
          Layer.provide(
            dynamicResponse((input) =>
              Effect.succeed(
                input.respond(
                  JSON.stringify({
                    answers: { refund: { type: "choice", choice: "yes", probabilities: { yes: 1 } } },
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )

  it.effect("rejects malformed questions before network I/O", () =>
    Effect.gen(function* () {
      const error = yield* Evaluation.run({
        model: TypeSafeAI.experimental.evaluation("jev-latest"),
        state: "hello",
        questions: { score: { type: "score", instructions: "How much?", criteria: ["only"] } },
      }).pipe(Effect.flip)
      expect(error.reason._tag).toBe("InvalidRequest")
    }).pipe(
      Effect.provide(
        EvaluationClient.layer.pipe(
          Layer.provide(dynamicResponse(() => Effect.die("invalid evaluation reached the network"))),
        ),
      ),
    ),
  )
})
