import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Evaluation, EvaluationModel, type EvaluationOptions } from "../../src/experimental.js"
import {
  Baseten,
  CloudflareAIGateway,
  CloudflareWorkersAI,
  DigitalOcean,
  OpenAI,
  OpenCode,
  OpenRouter,
  TypeSafeAI,
} from "../../src/providers.js"
import { recordedTests } from "../recorded-test.js"

const questions = {
  department: {
    type: "choice",
    instructions: "Which team should handle this support request?",
    criteria: {
      billing: "Payments, invoices, refunds, or failed charges",
      technical: "Bugs, outages, or integrations",
      sales: "Pricing, upgrades, or new accounts",
    },
  },
  urgency: {
    type: "score",
    instructions: "How urgent is this support request?",
    criteria: ["Can wait for normal support", "Needs prompt attention", "Actively blocking revenue"],
  },
  refund: { type: "boolean", instructions: "Is the customer asking for a refund?" },
} as const

const state = "I was charged twice for the same invoice. Please refund the duplicate payment today."

const typesafe = recordedTests({
  prefix: "typesafe-evaluation",
  provider: "typesafe-ai",
  protocol: "system-one",
  requires: ["TYPESAFE_API_KEY"],
  metadata: { model: "jev-latest" },
})

const opencode = recordedTests({
  prefix: "opencode-evaluation",
  provider: "opencode",
  protocol: "system-one",
  requires: ["OPENCODE_API_KEY"],
  metadata: { model: "jev-1.13-free" },
})

const openrouter = recordedTests({
  prefix: "openrouter-evaluation",
  provider: "openrouter",
  protocol: "system-one",
  requires: ["OPENROUTER_API_KEY"],
  metadata: { model: "typesafe/jev-1.13" },
})

const openai = recordedTests({
  prefix: "openai-evaluation",
  provider: "openai",
  protocol: "openai-decisions",
  requires: ["OPENAI_API_KEY"],
  metadata: { model: "gpt-6-luna" },
})

const cloudflareOptions = {
  redact: { url: (url: string) => url.replace(/\/client\/v4\/accounts\/[^/]+\//, "/client/v4/accounts/{account}/") },
}

const cloudflareWorkersAI = recordedTests({
  prefix: "cloudflare-workers-ai-evaluation",
  provider: "cloudflare-workers-ai",
  protocol: "system-one",
  requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"],
  metadata: { model: "@cf/cloudflare/clef" },
  options: cloudflareOptions,
})

const cloudflareAIGateway = recordedTests({
  prefix: "cloudflare-ai-gateway-evaluation",
  provider: "cloudflare-ai-gateway",
  protocol: "system-one",
  requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
  metadata: { model: "typesafe/jev" },
  options: cloudflareOptions,
})

const baseten = recordedTests({
  prefix: "baseten-evaluation",
  provider: "baseten",
  protocol: "system-one",
  requires: ["BASETEN_API_KEY"],
  metadata: { model: "decision-models/baseten-elephant-9b-latest" },
})

const digitalocean = recordedTests({
  prefix: "digitalocean-evaluation",
  provider: "digitalocean",
  protocol: "system-one",
  requires: ["DIGITALOCEAN_API_KEY"],
  metadata: { model: "typesafe-jev-1.13.0" },
})

describe("experimental Evaluation recorded", () => {
  typesafe.effect("evaluates choice score and boolean questions", () =>
    assertEvaluation(
      TypeSafeAI.configure({ apiKey: process.env.TYPESAFE_API_KEY ?? "fixture" }).experimental.evaluation("jev-latest"),
    ),
  )

  opencode.effect("evaluates choice score and boolean questions", () =>
    assertEvaluation(
      OpenCode.configure({ apiKey: process.env.OPENCODE_API_KEY ?? "fixture" }).experimental.evaluation(
        "jev-1.13-free",
      ),
    ),
  )

  openrouter.effect("evaluates choice score and boolean questions", () =>
    assertEvaluation(
      OpenRouter.configure({ apiKey: process.env.OPENROUTER_API_KEY ?? "fixture" }).experimental.evaluation(
        "typesafe/jev-1.13",
      ),
    ),
  )

  openai.effect("evaluates choice score and boolean questions about JSON state", () =>
    Effect.gen(function* () {
      const response = yield* Evaluation.run({
        model: OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY ?? "fixture" }).experimental.evaluation(
          "gpt-6-luna",
        ),
        state: { ticket: state, plan: "pro" },
        questions,
      })
      expect(response.model).toBe("gpt-6-luna")
      expect(response.answers.department.choice).toBe("billing")
      expect(response.answers.department.probabilities?.billing).toBeGreaterThan(0.5)
      expect(response.answers.department.confidence).toBeGreaterThan(0)
      expect(Object.keys(response.answers.urgency.probabilities ?? {})).toEqual(["0", "1", "2"])
      expect(response.answers.urgency.score).toBeGreaterThanOrEqual(0)
      expect(response.answers.urgency.score).toBeLessThanOrEqual(2)
      expect(response.answers.refund.probability).toBeGreaterThan(0.5)
      expect(response.usage?.inputTokens).toBeGreaterThan(0)
      expect(response.usage?.outputTokens).toBe(0)
    }),
  )

  cloudflareWorkersAI.effect("evaluates choice score and boolean questions", () =>
    assertEvaluation(
      CloudflareWorkersAI.configure({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "fixture-account",
        apiKey: process.env.CLOUDFLARE_API_KEY ?? "fixture",
      }).experimental.evaluation("@cf/cloudflare/clef"),
      "clef",
    ).pipe(
      Effect.map((response) => expect(response.rounding).toMatchObject({ probabilityDecimals: 4, scoreDecimals: 4 })),
    ),
  )

  cloudflareAIGateway.effect("evaluates choice score and boolean questions", () =>
    assertEvaluation(
      CloudflareAIGateway.configure({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "fixture-account",
        gatewayApiKey: process.env.CLOUDFLARE_API_TOKEN ?? "fixture",
      }).experimental.evaluation("typesafe/jev"),
    ).pipe(
      Effect.map((response) => expect(response.rounding).toMatchObject({ probabilityDecimals: 2, scoreDecimals: 2 })),
    ),
  )

  baseten.effect("evaluates choice score and boolean questions", () =>
    assertEvaluation(
      Baseten.configure({ apiKey: process.env.BASETEN_API_KEY ?? "fixture" }).experimental.evaluation(
        "decision-models/baseten-elephant-9b-latest",
      ),
      "baseten-",
    ).pipe(Effect.map((response) => expect(response.rounding).toBeUndefined())),
  )

  digitalocean.effect("evaluates choice score and boolean questions", () =>
    assertEvaluation(
      DigitalOcean.configure({ apiKey: process.env.DIGITALOCEAN_API_KEY ?? "fixture" }).experimental.evaluation(
        "typesafe-jev-1.13.0",
      ),
    ).pipe(
      Effect.map((response) => expect(response.rounding).toMatchObject({ probabilityDecimals: 2, scoreDecimals: 2 })),
    ),
  )
})

const assertEvaluation = <Options extends EvaluationOptions>(model: EvaluationModel<Options>, name = "jev-") =>
  Effect.gen(function* () {
    const response = yield* Evaluation.run({ model, state, questions })
    expect(response.model).toContain(name)
    expect(response.answers.department.type).toBe("choice")
    expect(response.answers.department.choice).toBe("billing")
    expect(response.answers.department.probabilities?.billing).toBeGreaterThan(0.5)
    expect(response.answers.urgency.type).toBe("score")
    expect(response.answers.urgency.score).toBeGreaterThanOrEqual(0)
    expect(response.answers.urgency.score).toBeLessThanOrEqual(2)
    expect(response.answers.refund.type).toBe("boolean")
    expect(response.answers.refund.probability).toBeGreaterThan(0.5)
    expect(response.usage?.inputTokens).toBeGreaterThan(0)
    expect(response.usage?.outputTokens).toBeDefined()
    expect(response.answers.department.confidence).toBeGreaterThan(0)
    expect(response.answers.urgency.confidence).toBeGreaterThan(0)
    return response
  })
