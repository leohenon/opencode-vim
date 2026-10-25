import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { isUpstreamOnlyWorkflow } from "../script/ocv-sync"
import { tmpdir } from "./fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"
import { initGit } from "../../core/test/fixture/git"

const guard = "github.repository == 'anomalyco/opencode'"
const yaml = (conditions: readonly (string | undefined)[], command = "echo fork") =>
  JSON.stringify({
    name: "inherited workflow",
    on: "workflow_dispatch",
    jobs: Object.fromEntries(
      conditions.map((condition, index) => [`job_${index}`, { if: condition, steps: [{ run: command }] }]),
    ),
  }) + "\n"

test.each([
  { conditions: [guard], allowed: true },
  { conditions: [guard, guard], allowed: true },
  { conditions: [`\${{ ${guard} }}`], allowed: true },
  { conditions: [], allowed: false },
  { conditions: [undefined], allowed: false },
  { conditions: [guard, undefined], allowed: false },
  { conditions: ["github.repository == 'leohenon/opencode-vim'"], allowed: false },
  { conditions: [`${guard} || github.repository == 'leohenon/opencode-vim'`], allowed: false },
  { conditions: [`(${guard}) && success()`], allowed: false },
])("workflow deletion admission %j", ({ conditions, allowed }) => {
  expect(isUpstreamOnlyWorkflow(yaml(conditions))).toBe(allowed)
})

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/sync-upstream.yml", import.meta.url)).text(),
) as { jobs: { sync: { steps: { name?: string; run?: string }[] } } }
const script = workflow.jobs.sync.steps.find((step) => step.name === "Merge upstream/dev")!.run!
const resolver = path.resolve(import.meta.dir, "../script/ocv-sync.ts")
const unix = process.platform === "win32" ? test.skip : test

unix.each([
  "deleted",
  "yaml-deleted",
  "fork-deleted",
  "mixed-deleted",
  "modified",
  "ours-deleted",
  "source-conflict",
] as const)("V2 workflow conflict resolution: %s", async (scenario) => {
  await using directory = await tmpdir()
  const upstream = path.join(directory.path, "upstream")
  const fork = path.join(directory.path, "fork")
  const file = `.github/workflows/inherited.${scenario === "yaml-deleted" ? "yaml" : "yml"}`
  const env = isolatedEnv(directory.path, {
    RUNNER_TEMP: directory.path,
    GITHUB_OUTPUT: path.join(directory.path, "outputs"),
    HUSKY: "0",
  })
  const git = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], {
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
  await mkdir(path.join(upstream, "packages/core"), { recursive: true })
  await Bun.write(path.join(upstream, "packages/core/package.json"), '{"version":"2.1.4"}\n')
  for (const name of ["AGENTS.md", "README.md", "install.sh", ".github/ocv-track"])
    await Bun.write(path.join(upstream, name), "fixture\n")
  await Bun.write(path.join(upstream, file), yaml([undefined], "echo base"))
  await Bun.write(path.join(upstream, "source.ts"), 'export const value = "base"\n')
  await git(upstream, "add", ".")
  await git(upstream, "commit", "-m", "upstream base")
  await git(upstream, "tag", "v2.1.4")
  await git(directory.path, "clone", upstream, fork)

  const conditions =
    scenario === "fork-deleted"
      ? ["github.repository == 'leohenon/opencode-vim'"]
      : scenario === "mixed-deleted"
        ? [guard, undefined]
        : [guard]
  if (scenario === "ours-deleted") await git(fork, "rm", file)
  else await Bun.write(path.join(fork, file), yaml(conditions))
  if (scenario === "source-conflict") await Bun.write(path.join(fork, "source.ts"), 'export const value = "fork"\n')
  await git(fork, "add", ".")
  await git(fork, "commit", "-m", "fork guard")
  const before = await git(fork, "rev-parse", "HEAD")
  if (scenario === "modified" || scenario === "ours-deleted")
    await Bun.write(path.join(upstream, file), yaml([undefined], "echo new upstream"))
  else await git(upstream, "rm", file)
  if (scenario === "source-conflict")
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
  const accepted = scenario === "deleted" || scenario === "yaml-deleted"
  expect(code === 0, stdout + stderr).toBe(accepted)
  if (accepted) {
    expect(await Bun.file(path.join(fork, file)).exists()).toBe(false)
    expect(await git(fork, "diff", "--name-only", "--diff-filter=U")).toBe("")
    expect(await git(fork, "log", "-1", "--format=%s")).toBe("chore(upstream): sync upstream dev")
  } else {
    expect(await git(fork, "rev-parse", "HEAD")).toBe(before)
    if (scenario === "source-conflict")
      expect(await git(fork, "diff", "--name-only", "--diff-filter=U")).toBe("source.ts")
    else {
      expect(stderr).toContain("manual review required")
      expect(await git(fork, "diff", "--name-only", "--diff-filter=U")).toBe(file)
    }
  }
})

test.each(["containers", "publish"])("guard tests handle deletion of %s safely", async (deleted) => {
  await using directory = await tmpdir()
  const source = new URL("../../../.github/workflows/", import.meta.url)
  for (const name of new Bun.Glob("*.yml").scanSync({ cwd: source.pathname })) {
    if (name === `${deleted}.yml`) continue
    await Bun.write(path.join(directory.path, ".github/workflows", name), Bun.file(new URL(name, source)))
  }
  const file = path.join(directory.path, "packages/cli/test/ocv-workflow-guards.test.ts")
  await Bun.write(file, Bun.file(new URL("./ocv-workflow-guards.test.ts", import.meta.url)))
  const child = Bun.spawn([process.execPath, "test", file], {
    cwd: directory.path,
    env: isolatedEnv(directory.path),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code === 0, stdout + stderr).toBe(deleted === "containers")
})
