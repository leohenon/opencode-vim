import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { context, plan } from "../../../.github/scripts/ocv-issues"

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/sync-upstream-v1.yml", import.meta.url)).text(),
) as {
  permissions: Record<string, string>
  jobs: Record<
    string,
    {
      if?: string
      needs?: string
      permissions?: Record<string, string>
      env?: Record<string, string>
      steps: { uses?: string; with?: Record<string, string>; run?: string }[]
    }
  >
}
const reporter = workflow.jobs.issues!
function execution(
  input: { result?: string; dryRun?: boolean; cancelled?: boolean; event?: string; branch?: string } = {},
) {
  return {
    always: () => true,
    cancelled: () => input.cancelled ?? false,
    inputs: { dry_run: input.dryRun ?? false },
    github: {
      repository: "leohenon/opencode-vim",
      ref: `refs/heads/${input.branch ?? "ocv"}`,
      event_name: input.event ?? "workflow_dispatch",
    },
    needs: { dispatch: { result: input.result ?? "failure" } },
  }
}
function evaluate(value: string, values: object) {
  return runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), values)
}
function input(result: string) {
  const env = Object.fromEntries(
    Object.entries(reporter.env!)
      .filter(([key]) => key.startsWith("OCV_ISSUE_"))
      .map(([key, value]) => [key, String(value.startsWith("${{") ? evaluate(value, execution({ result })) : value)]),
  )
  return context({
    ...env,
    GITHUB_REPOSITORY: "leohenon/opencode-vim",
    GITHUB_REF: "refs/heads/ocv",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "12345",
    GITHUB_WORKFLOW_REF: "leohenon/opencode-vim/.github/workflows/sync-upstream-v1.yml@refs/heads/ocv",
  })
}

test("dispatcher reports real failures and recoveries without requiring its broken PAT", () => {
  expect(reporter.needs).toBe("dispatch")
  expect(workflow.permissions.issues).toBeUndefined()
  expect(reporter.permissions).toEqual({ contents: "read", issues: "write" })
  expect(reporter.env?.GH_TOKEN).toBe("${{ github.token }}")
  expect(reporter.steps.find((step) => step.uses === "actions/checkout@v4")?.with?.ref).toBe(
    "${{ github.workflow_sha }}",
  )
  for (const result of ["success", "failure"] as const) {
    expect(evaluate(reporter.if!, execution({ result }))).toBe(true)
    expect(evaluate(reporter.if!, execution({ result, dryRun: true }))).toBe(false)
  }
  expect(evaluate(reporter.if!, execution({ event: "schedule" }))).toBe(true)
  expect(evaluate(reporter.if!, execution({ result: "cancelled" }))).toBe(false)
  expect(evaluate(reporter.if!, execution({ result: "skipped" }))).toBe(false)
  expect(evaluate(reporter.if!, execution({ cancelled: true }))).toBe(false)
  expect(evaluate(reporter.if!, execution({ branch: "ocv1" }))).toBe(false)
})

test("successful dispatch recovers only dispatch failure, never claims the actual V1 sync succeeded", () => {
  for (const result of ["success", "failure"] as const) {
    expect(plan(input(result))).toEqual([
      {
        title: "[ci]: sync upstream v1 dispatch failed",
        legacy: "[actions]: sync upstream v1 dispatch failed",
        labels: ["ci", "v1", "workflow:sync-dispatch"],
        result,
      },
    ])
  }
})
