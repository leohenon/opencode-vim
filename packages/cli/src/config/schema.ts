import { Config } from "@opencode/tui/config"
import { PRODUCT_NAME } from "@opencode/util/identity"
import { Schema } from "effect"

// The upstream schema does not describe OCV-only Vim and copy-mode settings.
export const SchemaURL = PRODUCT_NAME === "ocv" ? undefined : "https://opencode.ai/v2/cli.json"

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({ description: "JSON Schema for CLI configuration" }),
  ...Config.Info.fields,
})
export type Info = Schema.Schema.Type<typeof Info>

export function normalizeLegacyTabs(info: Info | undefined) {
  if (info?.tabs?.enabled === undefined) return info
  const tabs = { ...info.tabs }
  tabs.mode ??= tabs.enabled ? "on" : "off"
  delete tabs.enabled
  return { ...info, tabs }
}
