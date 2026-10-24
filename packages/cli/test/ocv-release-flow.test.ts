import { expect, test } from "bun:test"
import { mkdir, chmod } from "node:fs/promises"
import path from "node:path"
import { runInNewContext } from "node:vm"
import { tmpdir } from "./fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"
import { initGit } from "../../core/test/fixture/git"

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/publish-ocv.yml", import.meta.url)).text(),
) as {
  concurrency: { group: string; "cancel-in-progress": boolean }
  jobs: Record<
    string,
    {
      "runs-on": string
      outputs?: Record<string, string>
      steps: { id?: string; name?: string; run?: string; if?: string }[]
    }
  >
}
function step(name: string) {
  const result = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .find((item) => item.name === name)
  if (!result?.run) throw new Error(`Missing workflow script: ${name}`)
  return result
}
async function run(script: string, cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn(["bash", "-euo", "pipefail", "-c", script], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}
const unix = process.platform === "win32" ? test.skip : test

test("dry-run requests cannot replace pending publications and real versions remain serialized", () => {
  const group = (dry_run: boolean, version: string) =>
    workflow.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, value) =>
      String(runInNewContext(value, { inputs: { dry_run, version } })),
    )
  expect(group(true, "2.1.4-ocv.4.13")).not.toBe(group(false, "2.1.4-ocv.4.13"))
  expect(group(false, "2.1.4-ocv.4.13")).toBe(group(false, "2.1.5-ocv.4.13"))
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false)
})

test("Darwin signing and strict verification precede both distribution packagers", () => {
  const release = workflow.jobs.release!
  expect(release["runs-on"]).toBe("macos-latest")
  const names = release.steps.map((item) => item.name)
  const signing = names.indexOf("Sign and verify every Darwin binary")
  expect(signing).toBeGreaterThan(names.indexOf("Build every V2 CLI target with OCV identity"))
  expect(signing).toBeLessThan(names.indexOf("Pack npm distributions"))
  expect(signing).toBeLessThan(names.indexOf("Package GitHub release assets"))
  expect(step("Sign and verify every Darwin binary").run).toContain("arm64 x64 x64-baseline")
  expect(step("Sign and verify every Darwin binary").run).toContain("codesign --verify --strict")
})

unix("Homebrew rejects older retry versions before touching the current formula", async () => {
  await using directory = await tmpdir()
  await mkdir(path.join(directory.path, "Formula"))
  await mkdir(path.join(directory.path, "homebrew-formula"))
  const current = 'class OcvV2 < Formula\n  version "2.1.5-ocv.4.13"\nend\n'
  await Bun.write(path.join(directory.path, "Formula/ocv-v2.rb"), current)
  await Bun.write(path.join(directory.path, "homebrew-formula/ocv-v2.rb"), current.replace("2.1.5", "2.1.4"))
  const result = await run(
    step("Update only the V2 formula").run!,
    directory.path,
    isolatedEnv(directory.path, { VERSION: "2.1.4-ocv.4.13", RUNNER_TEMP: directory.path }),
  )
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("Refusing Homebrew downgrade")
  expect(await Bun.file(path.join(directory.path, "Formula/ocv-v2.rb")).text()).toBe(current)
})

unix("duplicate publication keeps public assets and avoids Github release create/upload/edit", async () => {
  await using directory = await tmpdir()
  const bin = path.join(directory.path, "bin")
  await mkdir(bin)
  await Bun.write(
    path.join(bin, "gh"),
    '#!/bin/sh\n[ "$1 $2" = "release download" ] || exit 99\nprintf "%s\\n" "$*" > "$FIXTURE_LOG"\n',
  )
  await chmod(path.join(bin, "gh"), 0o755)
  const script = step("Stage or resume draft prerelease").run!.replaceAll(
    "${{ steps.release_ref.outputs.published }}",
    "true",
  )
  const result = await run(
    script,
    directory.path,
    isolatedEnv(directory.path, {
      VERSION: "2.1.4-ocv.4.13",
      GITHUB_REPOSITORY: "leohenon/opencode-vim",
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FIXTURE_LOG: path.join(directory.path, "calls"),
    }),
  )
  expect(result.code, result.stderr).toBe(0)
  expect(await Bun.file(path.join(directory.path, "calls")).text()).toContain("release download v2.1.4-ocv.4.13")
  expect(step("Publish GitHub prerelease after npm succeeds").if).toContain(
    "steps.release_ref.outputs.published != 'true'",
  )
})

unix("queued duplicate adopts the already-published tag and validates as an idempotent release", async () => {
  await using directory = await tmpdir()
  const root = directory.path
  const env = {
    ...isolatedEnv(root, {
      VERSION: "2.1.4-ocv.4.13",
      GITHUB_REPOSITORY: "leohenon/opencode-vim",
      GITHUB_REF: "refs/heads/ocv",
      RUNNER_TEMP: root,
      GITHUB_OUTPUT: path.join(root, "outputs"),
    }),
    PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`,
  }
  await initGit(root, "-b", "ocv")
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    return stdout.trim()
  }
  await mkdir(path.join(root, ".github"))
  await mkdir(path.join(root, "packages/core"), { recursive: true })
  await mkdir(path.join(root, "bin"))
  await Bun.write(path.join(root, ".github/ocv-track"), "4.13\n")
  await Bun.write(path.join(root, "packages/core/package.json"), '{"version":"2.1.4"}\n')
  await git("add", ".github/ocv-track", "packages/core/package.json")
  await git("commit", "-m", "published source")
  const published = await git("rev-parse", "HEAD")
  await git("tag", "v2.1.4-ocv.4.13")
  await git("commit", "--allow-empty", "-m", "newer queued checkout")
  await git("update-ref", "refs/remotes/origin/ocv", "HEAD")
  await Bun.write(
    path.join(root, "bin/gh"),
    '#!/bin/sh\n[ "$1 $2" = "release list" ] || exit 99\nprintf \'[{"tagName":"v2.1.4-ocv.4.13","isDraft":false}]\\n\'\n',
  )
  await chmod(path.join(root, "bin/gh"), 0o755)
  expect((await run(step("Resolve existing V2 release source").run!, root, env)).code).toBe(0)
  expect(await git("rev-parse", "HEAD")).toBe(published)
  const result = await run(step("Validate OCV V2 version and release ref").run!, root, env)
  expect(result.code, result.stderr).toBe(0)
  expect(await Bun.file(path.join(root, "outputs")).text()).toBe("published=true\n")
})

test("an already-public identical release reports Github success even when finalization is skipped", () => {
  const expression = workflow.jobs.release!.outputs!.github!.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
  expect(
    runInNewContext(expression, {
      steps: {
        release_ref: { outputs: { published: "true" } },
        github_stage: { outcome: "success" },
        github_publish: { outcome: "skipped" },
      },
    }),
  ).toBe("success")
})
