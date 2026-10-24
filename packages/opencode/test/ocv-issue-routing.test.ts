import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { context, plan } from "../../../.github/scripts/ocv-issues"

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/publish-ocv.yml", import.meta.url)).text(),
) as { jobs: Record<string, { if?: string; env?: Record<string, string>; outputs?: Record<string, string> }> }
const reporter = workflow.jobs.issues!
const major = reporter.env!.OCV_ISSUE_MAJOR!
const version = `${major.slice(1)}.1.4-ocv.3.7`
function evaluate(value: string, values: object) {
  if (!value.startsWith("${{")) return value
  return runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), values)
}

// Evaluate the actual workflow output/env expressions, then feed them into the
// actual reporter planner. This checks the boundary between the two components.
function route(input: { release: string; github: string; npm: string; homebrew: string }) {
  const values = {
    inputs: { version, dry_run: false },
    steps: {
      github_release: { outcome: input.github },
      github_stage: { outcome: input.github === "skipped" && input.npm === "skipped" ? "skipped" : "success" },
      github_publish: { outcome: input.github },
      npm_publish: { outcome: input.npm },
      checkout_tap: { outcome: input.homebrew === "skipped" ? "skipped" : "success" },
      update_formula: { outcome: input.homebrew === "skipped" ? "skipped" : "success" },
      push_formula: { outcome: input.homebrew },
    },
    needs: {
      release: { result: input.release, outputs: {} as Record<string, string> },
      homebrew: { result: input.homebrew },
    },
  }
  values.needs.release.outputs = Object.fromEntries(
    Object.entries(workflow.jobs.release!.outputs!).map(([key, value]) => [key, String(evaluate(value, values))]),
  )
  const env = Object.fromEntries(
    Object.entries(reporter.env!)
      .filter(([key]) => key.startsWith("OCV_ISSUE_"))
      .map(([key, value]) => [key, String(evaluate(value, values))]),
  )
  return plan(
    context({
      ...env,
      GITHUB_REPOSITORY: "leohenon/opencode-vim",
      GITHUB_REF: `refs/heads/${major === "v1" ? "ocv1" : "ocv"}`,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "12345",
    }),
  )
}
const title = (channel: string) => `[ci]: ${channel} failed for v${version}`

test("pre-publication workflow failure opens only the version-scoped generic tracker", () => {
  const targets = route({ release: "failure", github: "skipped", npm: "skipped", homebrew: "skipped" })
  expect(targets).toHaveLength(1)
  expect(targets[0]).toMatchObject({
    title: title("release"),
    result: "failure",
    labels: ["ci", major, "workflow:release"],
  })
})

test("npm failure preserves the actual GitHub publication outcome", () => {
  const targets = route({
    release: "failure",
    github: major === "v1" ? "success" : "skipped",
    npm: "failure",
    homebrew: "skipped",
  })
  expect(targets.map((target) => [target.title, target.result])).toEqual([
    [title("npm publish"), "failure"],
    ...(major === "v1" ? [[title("GitHub release"), "success"]] : []),
  ])
})

test("GitHub publication failure preserves independent npm recovery", () => {
  const targets = route({ release: "failure", github: "failure", npm: "success", homebrew: "skipped" })
  expect(targets.map((target) => [target.title, target.result])).toEqual([
    [title("npm publish"), "success"],
    [title("GitHub release"), "failure"],
  ])
})

test("Homebrew failure cannot close its tracker merely because npm and GitHub succeeded", () => {
  const targets = route({
    release: major === "v1" ? "failure" : "success",
    github: "success",
    npm: "success",
    homebrew: "failure",
  })
  expect(targets.map((target) => [target.title, target.result])).toEqual([
    [title("npm publish"), "success"],
    [title("GitHub release"), "success"],
    [title("Homebrew tap update"), "failure"],
  ])
})

test("complete publication recovers only this exact version and its channel trackers", () => {
  const targets = route({ release: "success", github: "success", npm: "success", homebrew: "success" })
  expect(targets.map((target) => [target.title, target.result])).toEqual([
    [title("npm publish"), "success"],
    [title("GitHub release"), "success"],
    [title("Homebrew tap update"), "success"],
    [title("release"), "success"],
  ])
  expect(
    targets.every((target) => target.labels.includes(major) && !target.labels.includes(major === "v1" ? "v2" : "v1")),
  ).toBe(true)
})
