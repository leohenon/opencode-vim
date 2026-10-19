import { describe, expect, test } from "bun:test"
import path from "path"

const file = path.join(import.meta.dir, "../../src/plugin/index.ts")

describe("plugin builtin auth loading", () => {
  test("includes builtin anthropic auth plugin in runtime plugin list", async () => {
    const src = await Bun.file(file).text()

    expect(src).toContain('const BUILTIN = ["op-anthropic-auth"]')
    expect(src).toContain('flags: Pick<RuntimeFlags.Info, "pure" | "disableDefaultPlugins">')
    expect(src).toContain("const BUILTIN_ORIGINS = BUILTIN.map")
    expect(src).toContain("return ConfigPlugin.deduplicatePluginOrigins([...BUILTIN_ORIGINS, ...(list ?? [])])")
    expect(src).toContain("const items = plugins(cfg.plugin_origins, flags)")
  })
})
