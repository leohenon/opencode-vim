import { expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

// This is an Ubuntu CI shell stage; Windows does not provide its Bash/jq environment.
const unix = process.platform === "win32" ? test.skip : test

unix("CI smoke build derives and verifies its release identity from source and fork track", async () => {
  await using directory = await tmpdir()
  const workflow = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/workflows/ocv-ci.yml", import.meta.url)).text(),
  ) as { jobs: { check: { steps: { name?: string; run?: string }[] } } }
  const stage = workflow.jobs.check.steps.find((step) => step.name === "Build and smoke-test OCV identity")!
  await mkdir(path.join(directory.path, "packages/core"), { recursive: true })
  await mkdir(path.join(directory.path, ".github"))
  await mkdir(path.join(directory.path, "bin"))
  await Bun.write(path.join(directory.path, "packages/core/package.json"), JSON.stringify({ version: "2.7.9" }))
  await Bun.write(path.join(directory.path, ".github/ocv-track"), "5.23\n")
  const builder = path.join(directory.path, "bin/bun")
  await Bun.write(
    builder,
    `#!/bin/bash\nset -eu\n[ "$OPENCODE_VERSION" = "2.7.9-ocv.5.23" ]\nmkdir -p packages/cli/dist/cli-linux-x64/bin\nprintf '#!/bin/sh\\nprintf "ocv v%s\\\\n"\\n' "$OPENCODE_VERSION" > packages/cli/dist/cli-linux-x64/bin/opencode\nchmod +x packages/cli/dist/cli-linux-x64/bin/opencode\n`,
  )
  await chmod(builder, 0o755)
  const env = isolatedEnv(directory.path, {
    PATH: `${path.join(directory.path, "bin")}${path.delimiter}${process.env.PATH}`,
  })
  const run = async () => {
    const child = Bun.spawn(["bash", "-c", stage.run!], { cwd: directory.path, env, stdout: "pipe", stderr: "pipe" })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { code, stderr }
  }
  const correct = await run()
  expect(correct.code, correct.stderr).toBe(0)
  await Bun.write(path.join(directory.path, "packages/core/package.json"), JSON.stringify({ version: "1.19.4" }))
  expect((await run()).code).not.toBe(0)
})
