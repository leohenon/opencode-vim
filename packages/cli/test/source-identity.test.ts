import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"

test.each(["ocv", "opencode"])(
  "source %s child processes retain their parent's identity and storage roots",
  async (product) => {
    await using root = await tmpdir()
    const flags =
      product === "ocv" ? ["--define", 'OPENCODE_CLI_NAME="ocv"', "--define", 'OPENCODE_PRODUCT_NAME="ocv"'] : []
    const child = Bun.spawn([process.execPath, ...flags, path.join(import.meta.dir, "fixture/source-identity.ts")], {
      cwd: path.join(import.meta.dir, ".."),
      env: isolatedEnv(root.path, {
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        OPENCODE_CONFIG_DIR: undefined,
        OPENCODE_DB: undefined,
      }),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.parent.product).toBe(product)
    expect(result.child).toEqual(result.parent)
    expect(result.child.config).toBe(path.join(root.path, "xdg-config", product))
    expect(result.child.data).toBe(path.join(root.path, "data", product))
    expect(result.child.runtime).toBe(process.execPath)
  },
)
