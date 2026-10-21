import { expect, test } from "bun:test"
import { mainConfig } from "../vite.node.config"
import { nodeTarget } from "../src/node/target"

test("Node builds embed OCV identity and do not share the official native-asset cache", () => {
  const config = mainConfig({
    version: "2.0.32-ocv.4.13",
    channel: "ocv",
    assetHash: "test",
    target: nodeTarget("darwin", "arm64"),
  })
  expect(config.define).toMatchObject({
    OPENCODE_CLI_NAME: JSON.stringify("ocv"),
    OPENCODE_PRODUCT_NAME: JSON.stringify("ocv"),
    OPENCODE_CHANNEL: JSON.stringify("ocv"),
    OPENCODE_ARTIFACT: JSON.stringify("cli-node"),
  })
  expect(config.resolve?.builtins).toContain("fs")
  expect(config.resolve?.builtins).not.toContain("ws")
  expect(config.resolve?.builtins).not.toContain("undici")
  const external = config.build?.rollupOptions?.external
  if (typeof external !== "function") throw new Error("Expected a Node built-in predicate")
  expect(external("fs", undefined, false)).toBe(true)
  expect(external("node:fs", undefined, false)).toBe(true)
  expect(external("ws", undefined, false)).toBe(false)
  expect(external("undici", undefined, false)).toBe(false)
  const output = config.build?.rollupOptions?.output
  if (!output || Array.isArray(output)) throw new Error("Expected a single Node output")
  expect(output.banner).toContain("ocv-node-")
  expect(output.banner).not.toContain("`opencode-node-")
})
