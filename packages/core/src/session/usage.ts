export * as SessionUsage from "./usage.js"

import type { Usage } from "@opencode/ai"
import { Money } from "@opencode/schema/money"
import type { TokenUsage } from "@opencode/schema/token-usage"
import type { Model } from "@opencode/schema/model"

const finite = (value: number) => (Number.isFinite(value) ? value : 0)
const safe = (value: number | undefined) => Math.max(0, finite(value ?? 0))

export const tokens = (usage: Usage | undefined): TokenUsage.Info => ({
  input: safe(usage?.nonCachedInputTokens),
  output: safe(usage?.visibleOutputTokens),
  reasoning: safe(usage?.reasoningTokens),
  cache: {
    read: safe(usage?.cacheReadInputTokens),
    write: safe(usage?.cacheWriteInputTokens),
  },
})

// Catalog pricing is the fallback for endpoints that don't report what they charged (`Usage.cost`).
// TODO(#35765): Normalize Copilot's reported billed amount into `Usage.cost`.
export function calculateCost(costs: Model.Info["cost"], usage: TokenUsage.Info) {
  const context = usage.input + usage.cache.read + usage.cache.write
  const tier = costs
    .filter((cost) => cost.tier?.type === "context" && context > cost.tier.size)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  const cost = tier ?? costs.find((cost) => cost.tier === undefined)
  if (!cost) return Money.USD.zero
  return Money.USD.make(
    (usage.input * finite(cost.input) +
      (usage.output + usage.reasoning) * finite(cost.output) +
      usage.cache.read * finite(cost.cache.read) +
      usage.cache.write * finite(cost.cache.write)) /
      1_000_000,
  )
}

export type Recorded = {
  readonly tokens: TokenUsage.Info
  readonly cost: Money.USD
  /** Subscription allowance the endpoint reports the request used, such as OpenCode Go's. */
  readonly allowance?: Money.USD
}

export const record = (usage: Usage | undefined, costs: Model.Info["cost"]): Recorded => {
  const normalized = tokens(usage)
  return {
    tokens: normalized,
    // What an endpoint says it charged beats the catalog, which can't see its peak pricing, subscriptions or routing.
    // A reported zero is authoritative.
    cost: usage?.cost === undefined ? calculateCost(costs, normalized) : Money.USD.make(usage.cost),
    ...(usage?.allowance === undefined ? {} : { allowance: Money.USD.make(usage.allowance) }),
  }
}

export const add = (a: Recorded, b: Recorded): Recorded => ({
  cost: Money.USD.make(a.cost + b.cost),
  ...(a.allowance === undefined && b.allowance === undefined
    ? {}
    : { allowance: Money.USD.make((a.allowance ?? 0) + (b.allowance ?? 0)) }),
  tokens: {
    input: a.tokens.input + b.tokens.input,
    output: a.tokens.output + b.tokens.output,
    reasoning: a.tokens.reasoning + b.tokens.reasoning,
    cache: {
      read: a.tokens.cache.read + b.tokens.cache.read,
      write: a.tokens.cache.write + b.tokens.cache.write,
    },
  },
})
