import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"

const read = async (file: string) =>
  Bun.YAML.parse(await Bun.file(new URL(`../../../.github/workflows/${file}.yml`, import.meta.url)).text()) as {
    permissions: Record<string, string>
    jobs: Record<
      string,
      {
        needs?: string | string[]
        if?: string
        permissions?: Record<string, string>
        env?: Record<string, string>
        outputs?: Record<string, string>
        steps: { id?: string; uses?: string; run?: string; with?: Record<string, string> }[]
      }
    >
  }
const sync = await read("sync-upstream")
const release = await read("publish-ocv")

function evaluate(expression: string, context: Record<string, unknown>) {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), context)
}
function context(
  input: {
    dryRun?: boolean
    cancelled?: boolean
    event?: string
    branch?: string
    sync?: string
    release?: string
    homebrew?: string
  } = {},
) {
  return {
    always: () => true,
    cancelled: () => input.cancelled ?? false,
    inputs: { dry_run: input.dryRun ?? false, version: "2.1.4-ocv.4.13" },
    github: {
      repository: "leohenon/opencode-vim",
      ref: `refs/heads/${input.branch ?? "ocv"}`,
      event_name: input.event ?? "workflow_dispatch",
    },
    needs: {
      sync: { result: input.sync ?? "success" },
      release: { result: input.release ?? "success" },
      homebrew: { result: input.homebrew ?? "success" },
    },
  }
}

test("issue reporting uses its own checkout and write permission even when the main job failed early", () => {
  for (const workflow of [sync, release]) {
    const job = workflow.jobs.issues!
    expect(job.permissions).toEqual({ contents: "read", issues: "write" })
    expect(workflow.permissions.issues).toBeUndefined()
    expect(job.env?.OCV_ISSUE_MAJOR).toBe("v2")
    expect(job.steps.find((step) => step.uses === "actions/checkout@v4")?.with?.ref).toBe("${{ github.workflow_sha }}")
    expect(job.steps.some((step) => step.run === "bun .github/scripts/ocv-issues.ts")).toBe(true)
  }
  expect(sync.jobs.issues!.needs).toBe("sync")
  expect(release.jobs.issues!.needs).toEqual(["release", "homebrew"])
})

test("sync reports success and failure only on real V2 executions, including schedules", () => {
  for (const result of ["success", "failure"]) {
    expect(evaluate(sync.jobs.issues!.if!, context({ sync: result }))).toBe(true)
    expect(evaluate(sync.jobs.issues!.if!, context({ sync: result, dryRun: true }))).toBe(false)
  }
  for (const result of ["skipped", "cancelled"]) {
    expect(evaluate(sync.jobs.issues!.if!, context({ sync: result }))).toBe(false)
  }
  expect(evaluate(sync.jobs.issues!.if!, context({ event: "schedule" }))).toBe(true)
  expect(evaluate(sync.jobs.issues!.if!, context({ branch: "ocv1" }))).toBe(false)
  expect(evaluate(sync.jobs.issues!.if!, context({ cancelled: true }))).toBe(false)
})

test("release reporting catches pre-publication failures and partial channel failures", () => {
  const job = release.jobs.issues!
  expect(evaluate(job.if!, context({ release: "failure", homebrew: "skipped" }))).toBe(true)
  expect(evaluate(job.env!.OCV_ISSUE_RESULT!, context({ release: "failure", homebrew: "skipped" }))).toBe("failure")
  expect(evaluate(job.if!, context({ homebrew: "failure" }))).toBe(true)
  expect(evaluate(job.env!.OCV_ISSUE_RESULT!, context({ homebrew: "failure" }))).toBe("failure")
  expect(evaluate(job.env!.OCV_ISSUE_RESULT!, context())).toBe("success")
  expect(evaluate(job.if!, context({ dryRun: true }))).toBe(false)
  expect(evaluate(job.if!, context({ cancelled: true }))).toBe(false)
  expect(evaluate(job.if!, context({ branch: "ocv1" }))).toBe(false)
  expect(evaluate(job.if!, context({ release: "skipped", homebrew: "skipped" }))).toBe(false)
})

test("only completed public GitHub publication counts as channel recovery", () => {
  const output = release.jobs.release!.outputs!
  const steps = (stage: string, publish: string, npm: string) => ({
    steps: {
      release_ref: { outputs: { published: "false" } },
      github_stage: { outcome: stage },
      github_publish: { outcome: publish },
      npm_publish: { outcome: npm },
    },
  })
  expect(evaluate(output.github!, steps("success", "success", "success"))).toBe("success")
  expect(evaluate(output.github!, steps("success", "skipped", "failure"))).toBe("skipped")
  expect(evaluate(output.github!, steps("failure", "skipped", "skipped"))).toBe("failure")
  expect(evaluate(output.github!, steps("success", "failure", "success"))).toBe("failure")
  expect(evaluate(output.npm!, steps("success", "skipped", "failure"))).toBe("failure")
})
