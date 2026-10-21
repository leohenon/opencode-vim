import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { gitRemote } from "../../core/test/fixture/git"
import { isolatedEnv } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/publish-ocv.yml", import.meta.url)).text(),
) as {
  jobs: Record<
    string,
    {
      needs?: string
      if?: string
      steps: { name?: string; if?: string; run?: string; with?: Record<string, string> }[]
    }
  >
}
const version = "2.1.2-ocv.4.13"
const formula = `class OcvV2 < Formula\n  version "${version}"\nend\n`
const script = (job: string, name: string) => {
  const step = workflow.jobs[job]?.steps.find((step) => step.name === name)
  if (!step?.run) throw new Error(`Missing workflow script: ${name}`)
  return step.run
}
async function run(command: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

// The workflow runs on Ubuntu and its scripts require Bash/Ruby, not Windows shells.
const unix = process.platform === "win32" ? test.skip : test

unix("Homebrew is a separate non-dry-run job and missing credentials fail before publication", async () => {
  await using directory = await tmpdir()
  expect(workflow.jobs.homebrew?.needs).toBe("release")
  expect(workflow.jobs.homebrew?.if).toContain("inputs.dry_run == false")
  const step = workflow.jobs.release!.steps.find(
    (step) => step.name === "Require Homebrew tap credentials before publishing",
  )!
  expect(step.if).toBe("inputs.dry_run == false")
  const env = isolatedEnv(directory.path, { HOMEBREW_TAP_TOKEN: "" })
  expect((await run(["bash", "-c", step.run!], directory.path, env)).code).toBe(1)
  const configured = await run(["bash", "-c", step.run!], directory.path, {
    ...env,
    HOMEBREW_TAP_TOKEN: "fixture-only",
  })
  expect(configured.code, configured.stderr).toBe(0)
  const checkout = workflow.jobs.homebrew!.steps.find((step) => step.with?.repository)
  expect(checkout?.with?.repository).toBe("leohenon/homebrew-tap")
  expect(checkout?.with?.token).toBe("${{ secrets.HOMEBREW_TAP_TOKEN }}")
})

unix("formula download accepts published V2 only and rejects drafts or wrong versions", async () => {
  await using directory = await tmpdir()
  const bin = path.join(directory.path, "bin")
  await mkdir(bin)
  const source = path.join(directory.path, "source.rb")
  await Bun.write(source, formula)
  const gh = path.join(bin, "gh")
  await Bun.write(
    gh,
    `#!/bin/bash\nset -eu\ncase "$1 $2" in\n  'release view') printf '%s\\n' "$FIXTURE_DRAFT";;\n  'release download') mkdir -p "$RUNNER_TEMP/homebrew-formula"; cp "$FIXTURE_FORMULA" "$RUNNER_TEMP/homebrew-formula/ocv-v2.rb";;\n  *) exit 99;;\nesac\n`,
  )
  await run(["chmod", "+x", gh], directory.path, isolatedEnv(directory.path))
  const env = isolatedEnv(directory.path, {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    VERSION: version,
    GITHUB_REPOSITORY: "leohenon/opencode-vim",
    RUNNER_TEMP: directory.path,
    FIXTURE_DRAFT: "false",
    FIXTURE_FORMULA: source,
  })
  const command = ["bash", "-c", script("homebrew", "Download the published V2 formula")]
  const accepted = await run(command, directory.path, env)
  expect(accepted.code, accepted.stderr).toBe(0)
  expect((await run(command, directory.path, { ...env, FIXTURE_DRAFT: "true" })).code).toBe(1)
  expect((await run(command, directory.path, { ...env, VERSION: "1.19.4-ocv.4.13" })).code).toBe(1)
  await Bun.write(source, formula.replace(version, "2.1.1-ocv.4.13"))
  expect((await run(command, directory.path, env)).code).toBe(1)
})

unix("tap update creates only the V2 formula, is idempotent and can retry a failed push", async () => {
  await using directory = await tmpdir()
  const fixture = await gitRemote(directory.path)
  const env = isolatedEnv(directory.path, { VERSION: version, RUNNER_TEMP: directory.path })
  const git = async (cwd: string, ...args: string[]) => {
    const result = await run(["git", ...args], cwd, env)
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  const stable = "V1 formula must remain byte-for-byte unchanged\n"
  await mkdir(path.join(fixture.source, "Formula"))
  await Bun.write(path.join(fixture.source, "Formula/ocv.rb"), stable)
  await git(fixture.source, "add", "Formula/ocv.rb")
  await git(fixture.source, "commit", "-m", "V1 formula")
  await git(fixture.source, "push") // The fixture remote is file://, never GitHub.
  const before = await git(fixture.remote.replace("file://", ""), "rev-parse", "refs/heads/main")
  await mkdir(path.join(directory.path, "homebrew-formula"))
  await Bun.write(path.join(directory.path, "homebrew-formula/ocv-v2.rb"), formula)
  const hook = path.join(fixture.root, "origin.git/hooks/pre-receive")
  await Bun.write(hook, "#!/bin/sh\nexit 1\n")
  await run(["chmod", "+x", hook], fixture.source, env)
  const command = ["bash", "-c", script("homebrew", "Update only the V2 formula")]
  expect((await run(command, fixture.source, env)).code).not.toBe(0)
  const bare = path.join(fixture.root, "origin.git")
  expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(before)
  await Bun.write(hook, "#!/bin/sh\nexit 0\n")
  // A retried GitHub job gets a fresh checkout of the tap, not the failed job's local commit.
  const retry = path.join(directory.path, "retry")
  await git(directory.path, "clone", fixture.remote, retry)
  const updated = await run(command, retry, env)
  expect(updated.code, updated.stderr).toBe(0)
  const after = await git(bare, "rev-parse", "refs/heads/main")
  expect(after).not.toBe(before)
  expect(await git(bare, "diff", "--name-only", before, after)).toBe("Formula/ocv-v2.rb")
  expect(await git(bare, "show", "main:Formula/ocv.rb")).toBe(stable.trim())
  expect(await git(bare, "show", "main:Formula/ocv-v2.rb")).toBe(formula.trim())
  const same = await run(command, retry, env)
  expect(same.code, same.stderr).toBe(0)
  expect(await git(bare, "rev-parse", "refs/heads/main")).toBe(after)
})
