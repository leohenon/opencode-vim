import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { devNull } from "node:os"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"
import { initGit } from "../../core/test/fixture/git"

const yaml = (name: string) =>
  JSON.stringify({ name, on: "workflow_dispatch", jobs: { check: { steps: [{ run: `echo ${name}` }] } } }, null, 2) +
  "\n"
const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/sync-upstream.yml", import.meta.url)).text(),
) as { jobs: { sync: { steps: { name?: string; run?: string }[] } } }
const script = workflow.jobs.sync.steps.find((step) => step.name === "Merge upstream/dev")!.run!
const resolver = path.resolve(import.meta.dir, "../script/ocv-sync.ts")
const unix = process.platform === "win32" ? test.skip : test

unix.each([
  "addition",
  "yaml-addition",
  "clean-edit",
  "content-conflict",
  "deletion",
  "rename",
  "excluded-edit",
  "excluded-rename",
  "add-add",
  "directory-deletion",
  "source-only",
  "source-conflict",
] as const)("V2 preserves fork-owned workflows during %s", async (scenario) => {
  await using directory = await tmpdir()
  const upstream = path.join(directory.path, "upstream")
  const fork = path.join(directory.path, "fork")
  const env = isolatedEnv(directory.path, {
    RUNNER_TEMP: directory.path,
    GITHUB_OUTPUT: path.join(directory.path, "outputs"),
    HUSKY: "0",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    EMAIL: undefined,
  })
  const git = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.useConfigOnly=true", ...args], {
      cwd,
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
  await mkdir(upstream)
  await initGit(upstream, "-b", "dev")
  await Bun.write(path.join(upstream, "packages/core/package.json"), '{"version":"2.1.4"}\n')
  for (const name of ["AGENTS.md", "README.md", "install.sh", ".github/ocv-track"])
    await Bun.write(path.join(upstream, name), "fixture\n")
  for (const name of ["legacy.yml", "unchanged.yml", "nix.yml"])
    await Bun.write(path.join(upstream, ".github/workflows", name), yaml("upstream base"))
  await Bun.write(path.join(upstream, "source.ts"), 'export const value = "base"\n')
  await git(upstream, "add", ".")
  await git(upstream, "commit", "-m", "upstream base")
  await git(upstream, "tag", "v2.1.4")
  await git(directory.path, "clone", upstream, fork)
  await initGit(fork)

  await Bun.write(path.join(fork, ".github/workflows/legacy.yml"), yaml("fork version"))
  await Bun.write(path.join(fork, ".github/workflows/ocv-ci.yml"), yaml("fork CI"))
  await git(fork, "rm", ".github/workflows/nix.yml")
  if (scenario === "source-conflict") await Bun.write(path.join(fork, "source.ts"), 'export const value = "fork"\n')
  await git(fork, "add", ".")
  await git(fork, "commit", "-m", "fork workflows")
  const before = await git(fork, "rev-parse", "HEAD")
  const tree = await git(fork, "ls-tree", "-r", "HEAD", "--", ".github/workflows")

  if (scenario === "addition" || scenario === "yaml-addition")
    await Bun.write(
      path.join(upstream, `.github/workflows/new.${scenario === "addition" ? "yml" : "yaml"}`),
      yaml("new upstream"),
    )
  if (scenario === "clean-edit")
    await Bun.write(path.join(upstream, ".github/workflows/unchanged.yml"), yaml("upstream edit"))
  if (scenario === "content-conflict" || scenario === "source-conflict")
    await Bun.write(path.join(upstream, ".github/workflows/legacy.yml"), yaml("upstream edit"))
  if (scenario === "deletion") await git(upstream, "rm", ".github/workflows/legacy.yml")
  if (scenario === "rename")
    await git(upstream, "mv", ".github/workflows/legacy.yml", ".github/workflows/check-legacy.yml")
  if (scenario === "excluded-edit")
    await Bun.write(path.join(upstream, ".github/workflows/nix.yml"), yaml("updated Nix"))
  if (scenario === "excluded-rename")
    await git(upstream, "mv", ".github/workflows/nix.yml", ".github/workflows/check-nix.yml")
  if (scenario === "add-add")
    await Bun.write(path.join(upstream, ".github/workflows/ocv-ci.yml"), yaml("upstream collision"))
  if (scenario === "directory-deletion") await git(upstream, "rm", "-r", ".github/workflows")
  await Bun.write(path.join(upstream, "source.ts"), 'export const value = "upstream"\n')
  await git(upstream, "add", ".")
  await git(upstream, "commit", "-m", "upstream update")

  const child = Bun.spawn(
    [
      "bash",
      "-euo",
      "pipefail",
      "-c",
      script
        .replace("https://github.com/anomalyco/opencode.git", upstream)
        .replaceAll(
          "bun run packages/cli/script/ocv-sync.ts",
          `${JSON.stringify(process.execPath)} ${JSON.stringify(resolver)}`,
        ),
    ],
    { cwd: fork, env, stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code === 0, stdout + stderr).toBe(scenario !== "source-conflict")
  expect(await git(fork, "diff", "--cached", "--name-only", "HEAD", "--", ".github/workflows")).toBe("")
  expect(await git(fork, "diff", "--name-only", "--", ".github/workflows")).toBe("")
  expect(await git(fork, "ls-files", "--others", "--exclude-standard", "--", ".github/workflows")).toBe("")
  expect(await git(fork, "ls-tree", "-r", "HEAD", "--", ".github/workflows")).toBe(tree)
  expect(await Bun.file(path.join(fork, ".github/workflows/nix.yml")).exists()).toBe(false)
  expect(await Bun.file(path.join(fork, ".github/workflows/check-nix.yml")).exists()).toBe(false)
  if (scenario === "source-conflict") {
    expect(await git(fork, "rev-parse", "HEAD")).toBe(before)
    expect(await git(fork, "diff", "--name-only", "--diff-filter=U")).toBe("source.ts")
    return
  }
  expect(await git(fork, "diff", "--name-only", "--diff-filter=U")).toBe("")
  expect(await Bun.file(path.join(fork, "source.ts")).text()).toBe('export const value = "upstream"\n')
  expect(await git(fork, "log", "-1", "--format=%s")).toBe("chore(upstream): sync upstream dev")
  await git(fork, "merge-base", "--is-ancestor", "upstream/dev", "HEAD")
})
