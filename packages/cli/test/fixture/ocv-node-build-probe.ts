import assert from "node:assert/strict"
import { mainConfig } from "../../vite.node.config"
import { nodeTarget } from "../../src/node/target"

const config = mainConfig({
  version: "2.0.32-ocv.4.13",
  channel: "ocv",
  assetHash: "test",
  target: nodeTarget("darwin", "arm64"),
})
Object.entries({
  OPENCODE_CLI_NAME: JSON.stringify("ocv"),
  OPENCODE_PRODUCT_NAME: JSON.stringify("ocv"),
  OPENCODE_CHANNEL: JSON.stringify("ocv"),
  OPENCODE_ARTIFACT: JSON.stringify("cli-node"),
}).forEach(([key, value]) => assert.equal(config.define?.[key], value))
assert(config.resolve?.builtins?.includes("fs"))
assert(!config.resolve?.builtins?.includes("ws"))
assert(!config.resolve?.builtins?.includes("undici"))
const external = config.build?.rollupOptions?.external
assert(typeof external === "function", "Expected a Node built-in predicate")
assert.equal(external("fs", undefined, false), true)
assert.equal(external("node:fs", undefined, false), true)
assert.equal(external("ws", undefined, false), false)
assert.equal(external("undici", undefined, false), false)
const output = config.build?.rollupOptions?.output
assert(output && !Array.isArray(output), "Expected a single Node output")
assert(typeof output.banner === "string")
assert(output.banner.includes("ocv-node-"))
assert(!output.banner.includes("`opencode-node-"))
