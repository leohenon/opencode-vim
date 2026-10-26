import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("workflow names identify the upstream and V2 executions without changing routing", async () => {
  for (const [file, name, action] of [
    ["sync-upstream", "Sync ocv with upstream/dev", "Sync ocv with upstream/dev"],
    ["publish-ocv", "Release ocv", "release v"],
  ] as const) {
    const workflow = Bun.YAML.parse(
      await Bun.file(new URL(`../../../.github/workflows/${file}.yml`, import.meta.url)).text(),
    ) as {
      name: string
      "run-name": string
      on: { workflow_dispatch: { inputs: { dry_run: { default: boolean } } } }
      jobs: Record<string, { steps: { run?: string }[] }>
    }
    expect(workflow.name).toBe(name)
    expect(workflow["run-name"]).toContain(action)
    expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true)
    if (file === "publish-ocv") {
      expect(workflow["run-name"]).toBe("release v${{ inputs.version }}")
      continue
    }
    expect(workflow["run-name"]).toBe(name)
    const runs = workflow.jobs.sync!.steps.map((step) => step.run ?? "").join("\n")
    expect(runs).toContain('gh workflow run publish-ocv.yml --repo "$GITHUB_REPOSITORY" --ref ocv ')
    expect(runs).toContain("|package\\.json|packages/cli/package\\.json|")
    expect(runs).toContain("for file in package.json packages/cli/package.json bun.lock; do")
    expect(runs).toContain('bun run packages/cli/script/ocv-sync.ts "$file"')
  }
})

test("active V2 fork workflows pin the incoming upstream Bun version", async () => {
  for (const file of ["ocv-ci", "ocv-pages", "sync-upstream", "publish-ocv"]) {
    const workflow = Bun.YAML.parse(
      await Bun.file(new URL(`../../../.github/workflows/${file}.yml`, import.meta.url)).text(),
    ) as { jobs: Record<string, { steps?: { uses?: string; with?: { "bun-version"?: string } }[] }> }
    const steps = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.uses === "oven-sh/setup-bun@v2")
    expect(steps.length, file).toBeGreaterThan(0)
    for (const step of steps) expect(step.with?.["bun-version"], file).toBe("1.4.4")
  }
})

test("the workflow directory contains only fork-owned automation", async () => {
  const directory = new URL("../../../.github/workflows/", import.meta.url)
  const files = Array.from(new Bun.Glob("*.{yml,yaml}").scanSync({ cwd: fileURLToPath(directory) })).sort()
  expect(files).toEqual([
    "ocv-ci.yml",
    "ocv-pages.yml",
    "pr-management.yml",
    "pr-standards.yml",
    "publish-ocv.yml",
    "sync-upstream-v1.yml",
    "sync-upstream.yml",
  ])
  for (const name of files) {
    const workflow = Bun.YAML.parse(await Bun.file(new URL(name, directory)).text()) as {
      jobs: Record<string, { if?: string }>
    }
    expect(Object.keys(workflow.jobs).length, name).toBeGreaterThan(0)
    if (name === "pr-management.yml") {
      expect(Object.keys(workflow.jobs)).toEqual(["add-contributor-label"])
      continue
    }
    for (const [id, job] of Object.entries(workflow.jobs))
      expect(job.if, `${name}.${id}`).toContain("github.repository == 'leohenon/opencode-vim'")
  }
})

test("Pages deploys only the fork's ocv branch", async () => {
  const pages = Bun.YAML.parse(
    await Bun.file(new URL("../../../.github/workflows/ocv-pages.yml", import.meta.url)).text(),
  ) as {
    on: { push: { branches: string[] }; pull_request: { branches: string[] } }
    jobs: Record<string, { if?: string; needs?: string }>
  }
  expect(pages.on.push.branches).toEqual(["ocv"])
  expect(pages.on.pull_request.branches).toEqual(["ocv"])
  expect(pages.jobs.build!.if).toBe("github.repository == 'leohenon/opencode-vim'")
  expect(pages.jobs.deploy!.needs).toBe("build")
  expect(pages.jobs.deploy!.if).toContain("github.repository == 'leohenon/opencode-vim'")
  expect(pages.jobs.deploy!.if).toContain("github.event_name != 'pull_request'")
  expect(pages.jobs.deploy!.if).toContain("github.ref == 'refs/heads/ocv'")
})
