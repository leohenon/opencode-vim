import { expect, test } from "bun:test"

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
