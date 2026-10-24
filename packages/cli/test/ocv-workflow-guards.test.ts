import { expect, test } from "bun:test"

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

// These persisted job conditions keep upstream automation off forks, including manual runs.
test("upstream-only jobs require the upstream repository and publication requires a successful version", async () => {
  const workflows = await Promise.all(
    [
      "close-issues",
      "close-prs",
      "compliance-close",
      "triage",
      "containers",
      "publish-github-action",
      "release-github-action",
      "publish-vscode",
      "notify-discord",
      "publish",
      "check",
      "storybook",
      "test",
    ].map(async (name) => ({
      name,
      workflow: Bun.YAML.parse(
        await Bun.file(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url)).text(),
      ) as { jobs: Record<string, { if?: string; needs?: string | string[] }> },
    })),
  )

  for (const { name, workflow } of workflows) {
    expect(Object.keys(workflow.jobs).length, name).toBeGreaterThan(0)
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(job.if, `${name}.${id}`).toContain("github.repository == 'anomalyco/opencode'")
    }
  }

  const publish = workflows.find((entry) => entry.name === "publish")!.workflow.jobs.publish!
  expect(publish.needs).toContain("version")
  expect(publish.if).toBe(
    "github.repository == 'anomalyco/opencode' && needs.version.result == 'success' && (always() && !failure() && !cancelled())",
  )
  const tests = workflows.find((entry) => entry.name === "test")!.workflow.jobs
  expect(tests["e2e-suite"]!.if).toBe(
    "github.repository == 'anomalyco/opencode' && (needs.affected.outputs.e2e == 'true')",
  )
  expect(tests.e2e!.if).toBe("${{ github.repository == 'anomalyco/opencode' && (!cancelled()) }}")
})

test("V2 has no Nix automation and Pages deploys only the fork's ocv branch", async () => {
  for (const name of ["nix-eval", "nix-hashes", "nix-hashes-ocv"])
    expect(await Bun.file(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url)).exists()).toBe(false)
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
