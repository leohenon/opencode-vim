import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { context, owns, plan } from "../../../.github/scripts/ocv-issues"

// These integration fixtures use an extensionless POSIX shebang executable for gh.
// The reporter runs on Ubuntu; pure ownership/planning checks also run on Windows.
const unix = process.platform === "win32" ? test.skip : test

type FixtureIssue = {
  number: number
  title: string
  labels: { name: string }[]
  state: string
  body: string
  comments: string[]
}
function issue(number: number, title: string, labels: string[] = []): FixtureIssue {
  return { number, title, labels: labels.map((name) => ({ name })), state: "open", body: "old", comments: [] }
}
const base = {
  OCV_ISSUE_MAJOR: "v2",
  OCV_ISSUE_WORKFLOW: "sync",
  OCV_ISSUE_RESULT: "failure",
  OCV_ISSUE_DRY_RUN: "false",
  GITHUB_REPOSITORY: "leohenon/opencode-vim",
  GITHUB_REF: "refs/heads/ocv",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_RUN_ID: "12345",
}
const version = "2.1.4-ocv.3.7"
const release = { OCV_ISSUE_WORKFLOW: "release", OCV_ISSUE_VERSION: version }
const sync = "[ci]: sync upstream failed"
const dispatch = {
  OCV_ISSUE_MAJOR: "v1",
  OCV_ISSUE_WORKFLOW: "sync-dispatch",
  GITHUB_WORKFLOW_REF: "leohenon/opencode-vim/.github/workflows/sync-upstream-v1.yml@refs/heads/ocv",
}
const dispatchTitle = "[ci]: sync upstream v1 dispatch failed"
const title = (channel: string, value = version) => `[ci]: ${channel} failed for v${value}`

// The actual script runs in a child with a private HOME and a PATH containing only
// this stateful gh executable. No inherited credentials or real gh can be used.
async function fixture(
  initial: FixtureIssue[] = [],
  options: { parallelLabels?: boolean; fail?: string; lookup?: string } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "ocv-issues-"))
  const state = path.join(root, "state.json")
  await Bun.write(
    state,
    JSON.stringify({
      issues: initial,
      labels: [{ name: "ci", color: "abcdef", description: "keep me" }],
      calls: [],
      ...options,
    }),
  )
  await Bun.write(
    path.join(root, "gh"),
    `#!${process.execPath}
import { mkdir, rmdir } from "node:fs/promises"
const file = Bun.file(process.env.FAKE_STATE)
const snapshot = await file.json()
const args = process.argv.slice(2)
const listing = args[3] === "repos/leohenon/opencode-vim/labels?per_page=100"
const deadline = Date.now() + 10000
if (snapshot.parallelLabels && listing) {
  // Both reporters must capture their label snapshots before either may create.
  await Bun.write(process.env.FAKE_STATE + "." + process.env.OCV_ISSUE_MAJOR, "ready")
  while (!(await Bun.file(process.env.FAKE_STATE + ".v1").exists()) || !(await Bun.file(process.env.FAKE_STATE + ".v2").exists())) {
    if (Date.now() > deadline) throw Error("Snapshot barrier timed out")
    await Bun.sleep(1)
  }
}
// Serialize the fake API's state transactions, not the reporters themselves.
const lock = process.env.FAKE_STATE + ".lock"
while (true) {
  const acquired = await mkdir(lock).then(() => true, (error) => {
    if (error.code !== "EEXIST") throw error
    return false
  })
  if (acquired) break
  if (Date.now() > deadline) throw Error("State lock timed out")
  await Bun.sleep(1)
}
const state = await file.json()
const finish = async (code, output) => {
  await Bun.write(file, JSON.stringify(state))
  await rmdir(lock)
  if (code) process.stderr.write(output)
  else process.stdout.write(output)
  process.exit(code)
}
if (process.env.GH_TOKEN !== "fixture-token" || process.env.GITHUB_TOKEN || process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN || process.env.HOME !== process.env.FAKE_HOME) throw Error("Unsafe environment")
state.calls.push(args)
const values = (flag) => args.flatMap((arg, i) => arg === flag ? [args[i + 1]] : [])
const value = (flag) => values(flag)[0]
if (args[0] !== "api" && value("--repo") !== "leohenon/opencode-vim") throw Error("Wrong repo")
let output = ""
if (args[0] === "api") {
  if (args[3] === "repos/leohenon/opencode-vim/issues?state=open&per_page=100") output = JSON.stringify([state.issues.filter((issue) => issue.state === "open").slice(0, 1), state.issues.filter((issue) => issue.state === "open").slice(1)])
  else if (listing) output = JSON.stringify([snapshot.parallelLabels ? snapshot.labels : state.labels])
  else if (args[1].startsWith("repos/leohenon/opencode-vim/labels/")) {
    const name = decodeURIComponent(args[1].split("/labels/")[1])
    const label = state.labels.find((label) => label.name === name)
    if (state.lookup === "denied") await finish(1, "HTTP 403: forbidden")
    if (!label) await finish(1, "HTTP 404: label missing")
    output = JSON.stringify(state.lookup === "mismatch" ? { name: "other" } : label)
  } else throw Error("Unexpected API")
} else if (args[0] === "label" && args[1] === "create") {
  if (args.includes("--force")) throw Error("Label overwritten")
  if (state.fail === "label") await finish(1, "HTTP 403: label creation forbidden")
  if (state.labels.some((label) => label.name === args[2])) await finish(1, "HTTP 422: label already exists")
  state.labels.push({ name: args[2], color: "123456", description: "first creator" })
  if (state.fail === "label-race") await finish(1, "HTTP 422: concurrent label creation")
} else if (args[0] === "issue") {
  if (args[1] === "create") {
    state.issues.push({ number: Math.max(0, ...state.issues.map((issue) => issue.number)) + 1, title: value("--title"), body: value("--body"), labels: values("--label").map((name) => ({name})), state: "open", comments: [] })
  } else {
    const issue = state.issues.find((issue) => issue.number === Number(args[2]))
    if (!issue) throw Error("Unknown issue")
    if (args[1] === "edit") {
      if (value("--title")) issue.title = value("--title")
      if (value("--body")) issue.body = value("--body")
      for (const name of values("--add-label")) if (!issue.labels.some((label) => label.name === name)) issue.labels.push({name})
    } else if (args[1] === "close") {
      // gh's --comment posts before closing, even if close later fails.
      if (value("--comment")) issue.comments.push(value("--comment"))
      if (state.fail === "close") {
        delete state.fail
        await finish(1, "HTTP 502: close failed before mutation")
      }
      issue.state = "closed"
    } else if (args[1] === "comment") {
      // A response can fail after the comment was accepted, too.
      if (state.fail === "comment-before") {
        delete state.fail
        await finish(1, "HTTP 502: comment failed before mutation")
      }
      issue.comments.push(value("--body"))
      if (state.fail === "comment-after") {
        delete state.fail
        await finish(1, "HTTP 502: comment response lost")
      }
    } else throw Error("Unexpected issue command")
  }
} else throw Error("Unexpected command")
await finish(0, output)
`,
  )
  const { chmod } = await import("node:fs/promises")
  await chmod(path.join(root, "gh"), 0o755)
  return {
    async run(overrides: Record<string, string | undefined> = {}) {
      const child = Bun.spawn(
        [process.execPath, path.resolve(import.meta.dir, "../../../.github/scripts/ocv-issues.ts")],
        {
          env: {
            ...base,
            ...overrides,
            PATH: root,
            HOME: root,
            XDG_CONFIG_HOME: root,
            GH_CONFIG_DIR: root,
            GH_TOKEN: "fixture-token",
            FAKE_HOME: root,
            FAKE_STATE: state,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, code }
    },
    async read(): Promise<{
      issues: FixtureIssue[]
      labels: { name: string; color?: string; description?: string }[]
      calls: string[][]
    }> {
      return Bun.file(state).json()
    },
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

for (const major of ["v1", "v2"] as const) {
  const env = { OCV_ISSUE_MAJOR: major, GITHUB_REF: `refs/heads/${major === "v1" ? "ocv1" : "ocv"}` }
  const own = major === "v1" ? "[ci]: sync upstream v1 failed" : sync
  const opposite = major === "v1" ? "v2" : "v1"
  unix(`${major} adopts oldest unlabelled tracker, isolates opposite major, and failures are idempotent`, async () => {
    await using f = await fixture([
      issue(400, own),
      issue(267, own.replace("[ci]", "[actions]")),
      issue(1, own, [opposite]),
      issue(2, major === "v1" ? sync : "[ci]: sync upstream v1 failed"),
    ])
    expect(await f.run(env)).toMatchObject({ code: 0, stderr: "" })
    expect(await f.run({ ...env, GITHUB_RUN_ID: "23456" })).toMatchObject({ code: 0, stderr: "" })
    const state = await f.read()
    expect(state.issues).toHaveLength(4)
    expect(state.issues[1]).toMatchObject({
      title: own,
      body: "Workflow failure: https://github.com/leohenon/opencode-vim/actions/runs/23456",
      comments: [],
    })
    expect(state.issues[1].labels.map((label) => label.name)).toEqual(["ci", major, "workflow:sync"])
    expect(state.issues.filter((item) => item.number !== 267).every((item) => item.body === "old")).toBe(true)
    expect(state.labels[0]).toEqual({ name: "ci", color: "abcdef", description: "keep me" })
    expect(state.calls.filter((args) => args[0] === "label")).toHaveLength(2)
    expect(await f.run({ ...env, OCV_ISSUE_RESULT: "success" })).toMatchObject({ code: 0, stderr: "" })
    const closed = (await f.read()).issues
    expect(closed.filter((item) => item.state === "closed").map((item) => item.number)).toEqual([400, 267])
    expect(closed[0].comments).toEqual(["Recovered: https://github.com/leohenon/opencode-vim/actions/runs/12345"])
  })
}

unix("generic unlabelled #267 belongs only to v2; v1 creates a distinct tracker", async () => {
  await using f = await fixture([issue(267, sync)])
  expect((await f.run({ OCV_ISSUE_MAJOR: "v1", GITHUB_REF: "refs/heads/ocv1" })).code).toBe(0)
  expect((await f.read()).issues.map((item) => item.title)).toEqual([sync, "[ci]: sync upstream v1 failed"])
  expect((await f.run({ OCV_ISSUE_RESULT: "success" })).code).toBe(0)
  expect((await f.read()).issues.map((item) => item.state)).toEqual(["closed", "open"])
})

unix("release recovery closes only exact version/channel and handles legacy duplicates", async () => {
  const owned = title("npm publish")
  await using f = await fixture([
    issue(1, owned),
    issue(2, owned.replace("[ci]", "[actions]")),
    issue(3, title("npm publish", "2.1.4-ocv.3.6")),
    issue(4, title("Homebrew tap update")),
    issue(5, title("GitHub release")),
    issue(6, title("release")),
    issue(7, owned, ["v1"]),
    issue(8, title("npm publish", "1.1.4-ocv.3.7")),
    issue(9, "unrelated"),
  ])
  expect(
    await f.run({ ...release, OCV_ISSUE_NPM: "success", OCV_ISSUE_GITHUB: "failure", OCV_ISSUE_HOMEBREW: "cancelled" }),
  ).toMatchObject({ code: 0, stderr: "" })
  const state = await f.read()
  expect(state.issues.filter((item) => item.state === "closed").map((item) => item.number)).toEqual([1, 2])
  expect(state.issues[4].body).toContain("/runs/12345")
  expect(state.issues[5].body).toBe("old")
  expect(state.issues[0].labels.map((label) => label.name)).toEqual(["ci", "v2", "workflow:release", "channel:npm"])
  expect(
    state.issues
      .filter((item) => ![1, 2, 5].includes(item.number))
      .every((item) => item.body === "old" && item.comments.length === 0),
  ).toBe(true)
})

unix("build/validation/Nix failures create one generic tracker; success closes it", async () => {
  await using f = await fixture()
  expect((await f.run({ ...release, OCV_ISSUE_NPM: "skipped", OCV_ISSUE_GITHUB: "cancelled" })).code).toBe(0)
  expect((await f.run(release)).code).toBe(0)
  expect((await f.read()).issues).toHaveLength(1)
  expect((await f.read()).issues[0]).toMatchObject({ title: title("release"), state: "open" })
  expect((await f.run({ ...release, OCV_ISSUE_RESULT: "success" })).code).toBe(0)
  expect((await f.read()).issues[0].state).toBe("closed")
})

unix("channel failures create only their trackers with full versions and recover independently", async () => {
  await using f = await fixture()
  expect(
    (await f.run({ ...release, OCV_ISSUE_NPM: "failure", OCV_ISSUE_HOMEBREW: "failure", OCV_ISSUE_GITHUB: "failure" }))
      .code,
  ).toBe(0)
  const state = await f.read()
  expect(state.issues.map((item) => item.title)).toEqual([
    title("npm publish"),
    title("GitHub release"),
    title("Homebrew tap update"),
  ])
  expect(state.issues.map((item) => item.labels.map((label) => label.name))).toEqual(
    ["npm", "github", "homebrew"].map((channel) => ["ci", "v2", "workflow:release", `channel:${channel}`]),
  )
  expect(
    (await f.run({ ...release, OCV_ISSUE_NPM: "failure", OCV_ISSUE_HOMEBREW: "success", OCV_ISSUE_GITHUB: "skipped" }))
      .code,
  ).toBe(0)
  expect((await f.read()).issues.map((item) => item.state)).toEqual(["open", "open", "closed"])
})

unix("parallel v1/v2 reporters tolerate shared label creation races without overwriting metadata", async () => {
  await using f = await fixture([], { parallelLabels: true })
  const results = await Promise.all([f.run({ OCV_ISSUE_MAJOR: "v1", GITHUB_REF: "refs/heads/ocv1" }), f.run()])
  expect(results).toEqual([
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "", stderr: "" },
  ])
  const state = await f.read()
  expect(state.issues.map((item) => item.title).sort()).toEqual([sync, "[ci]: sync upstream v1 failed"].sort())
  for (const item of state.issues) {
    expect(item.labels.map((label) => label.name)).toEqual(["ci", item.title === sync ? "v2" : "v1", "workflow:sync"])
  }
  expect(state.labels).toHaveLength(4)
  expect(state.labels[0]).toEqual({ name: "ci", color: "abcdef", description: "keep me" })
  expect(
    state.labels.slice(1).every((label) => label.color === "123456" && label.description === "first creator"),
  ).toBe(true)
  expect(state.calls.filter((args) => args[0] === "label" && args[2] === "workflow:sync")).toHaveLength(2)
  expect(state.calls.filter((args) => args[1] === "repos/leohenon/opencode-vim/labels/workflow%3Async")).toHaveLength(1)
  expect(state.calls.some((args) => args.includes("--force"))).toBe(false)
})

unix("failed label creation requires a successful exact-name lookup and propagates genuine errors", async () => {
  for (const options of [
    { fail: "label" },
    { fail: "label", lookup: "denied" },
    { fail: "label-race", lookup: "denied" },
    { fail: "label-race", lookup: "mismatch" },
  ]) {
    await using f = await fixture([], options)
    const result = await f.run()
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("gh label failed")
    const state = await f.read()
    expect(state.issues).toEqual([])
    expect(state.calls.at(-1)).toEqual(["api", "repos/leohenon/opencode-vim/labels/v2"])
  }
})

unix("failed close posts no recovery comment; retry closes with exactly one comment", async () => {
  await using f = await fixture([issue(267, sync)], { fail: "close" })
  const recovery = { OCV_ISSUE_RESULT: "success" }
  const failed = await f.run(recovery)
  expect(failed.code).not.toBe(0)
  expect(failed.stderr).toContain("close failed before mutation")
  expect((await f.read()).issues[0]).toMatchObject({ state: "open", comments: [] })
  expect(await f.run(recovery)).toMatchObject({ code: 0, stderr: "" })
  expect(await f.run(recovery)).toMatchObject({ code: 0, stderr: "" })
  const state = await f.read()
  expect(state.issues[0]).toMatchObject({
    state: "closed",
    comments: ["Recovered: https://github.com/leohenon/opencode-vim/actions/runs/12345"],
  })
  expect(state.calls.filter((args) => args[1] === "close")).toHaveLength(2)
  expect(state.calls.filter((args) => args[1] === "close").every((args) => !args.includes("--comment"))).toBe(true)
  expect(state.calls.filter((args) => args[1] === "comment")).toHaveLength(1)
})

for (const fail of ["comment-before", "comment-after"]) {
  unix(`${fail} cannot prevent closure or duplicate recovery comments on retry`, async () => {
    await using f = await fixture([issue(267, sync)], { fail })
    const recovery = { OCV_ISSUE_RESULT: "success" }
    const failed = await f.run(recovery)
    expect(failed.code).not.toBe(0)
    expect(failed.stderr).toContain("gh issue failed")
    const closed = (await f.read()).issues[0]
    expect(closed.state).toBe("closed")
    expect(closed.comments).toHaveLength(fail === "comment-before" ? 0 : 1)
    expect(await f.run(recovery)).toMatchObject({ code: 0, stderr: "" })
    const state = await f.read()
    expect(state.issues[0]).toEqual(closed)
    expect(state.calls.filter((args) => args[1] === "comment")).toHaveLength(1)
    const mutations = state.calls.filter((args) => args[0] === "issue").map((args) => args[1])
    expect(mutations).toEqual(["edit", "close", "comment"])
  })
}

unix("dispatch failure adopts legacy tracker, isolates actual sync, and recovers independently", async () => {
  await using f = await fixture([
    issue(1, "[ci]: sync upstream v1 failed"),
    issue(2, sync),
    issue(3, dispatchTitle.replace("[ci]", "[actions]")),
    issue(4, dispatchTitle, ["v2"]),
  ])
  expect(await f.run(dispatch)).toMatchObject({ code: 0, stderr: "" })
  expect(await f.run(dispatch)).toMatchObject({ code: 0, stderr: "" })
  const failed = (await f.read()).issues
  expect(failed).toHaveLength(4)
  expect(failed[2]).toMatchObject({ title: dispatchTitle, state: "open" })
  expect(failed[2].labels.map((label) => label.name)).toEqual(["ci", "v1", "workflow:sync-dispatch"])
  expect(failed.filter((item) => item.number !== 3).every((item) => item.body === "old")).toBe(true)
  expect(await f.run({ ...dispatch, OCV_ISSUE_RESULT: "success" })).toMatchObject({ code: 0, stderr: "" })
  expect((await f.read()).issues.map((item) => item.state)).toEqual(["open", "open", "closed", "open"])
})

unix("actual v1 sync recovery cannot close dispatch failure; dispatch recovery cannot close sync failure", async () => {
  await using f = await fixture()
  const actual = { OCV_ISSUE_MAJOR: "v1", GITHUB_REF: "refs/heads/ocv1" }
  expect(await f.run(dispatch)).toMatchObject({ code: 0, stderr: "" })
  expect(await f.run(actual)).toMatchObject({ code: 0, stderr: "" })
  expect((await f.read()).issues.map((item) => item.title)).toEqual([dispatchTitle, "[ci]: sync upstream v1 failed"])
  expect(await f.run({ ...actual, OCV_ISSUE_RESULT: "success" })).toMatchObject({ code: 0, stderr: "" })
  expect((await f.read()).issues.map((item) => item.state)).toEqual(["open", "closed"])
  expect(await f.run(actual)).toMatchObject({ code: 0, stderr: "" })
  expect(await f.run({ ...dispatch, OCV_ISSUE_RESULT: "success" })).toMatchObject({ code: 0, stderr: "" })
  expect((await f.read()).issues.map((item) => item.state)).toEqual(["closed", "closed", "open"])
})

test("dispatch planning ignores release channel stages", () => {
  const input = context({
    ...base,
    ...dispatch,
    OCV_ISSUE_NPM: "failure",
    OCV_ISSUE_GITHUB: "success",
    OCV_ISSUE_HOMEBREW: "cancelled",
  })
  expect(plan(input)).toEqual([
    {
      title: dispatchTitle,
      legacy: dispatchTitle.replace("[ci]", "[actions]"),
      labels: ["ci", "v1", "workflow:sync-dispatch"],
      result: "failure",
    },
  ])
})

unix("dispatch scope, ref and workflow identity are exact and refuse before gh", async () => {
  await using f = await fixture()
  for (const overrides of [
    { OCV_ISSUE_MAJOR: "v2" },
    { OCV_ISSUE_MAJOR: "v3" },
    { GITHUB_REF: "refs/heads/ocv1" },
    { GITHUB_REF: "refs/pull/1/merge" },
    { GITHUB_REPOSITORY: "other/opencode-vim" },
    ...[
      undefined,
      "",
      "leohenon/opencode-vim/.github/workflows/sync-upstream.yml@refs/heads/ocv",
      "leohenon/opencode-vim/.github/workflows/sync-upstream-v1.yml@refs/heads/ocv1",
      "leohenon/opencode-vim/.github/workflows/release-v1.yml@refs/heads/ocv",
      "other/opencode-vim/.github/workflows/sync-upstream-v1.yml@refs/heads/ocv",
      "leohenon/opencode-vim/.github/workflows/sync-upstream-v1.yml@refs/tags/ocv",
    ].map((GITHUB_WORKFLOW_REF) => ({ GITHUB_WORKFLOW_REF })),
  ]) {
    const result = await f.run({ ...dispatch, ...overrides })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Invalid")
  }
  for (const workflow of ["sync", "release"]) {
    expect(
      (await f.run({ ...dispatch, ...release, OCV_ISSUE_WORKFLOW: workflow, OCV_ISSUE_VERSION: "1.9.0-ocv.2.3" })).code,
    ).not.toBe(0)
  }
  expect((await f.read()).calls).toEqual([])
})

test("v1 release preserves title format without redundant major words", () => {
  const input = context({
    ...base,
    ...release,
    OCV_ISSUE_MAJOR: "v1",
    GITHUB_REF: "refs/heads/ocv1",
    OCV_ISSUE_VERSION: "v1.9.0-ocv.2.3",
    OCV_ISSUE_NPM: "failure",
    OCV_ISSUE_GITHUB: "failure",
    OCV_ISSUE_HOMEBREW: "failure",
  })
  expect(plan(input).map((item) => item.title)).toEqual([
    "[ci]: npm publish failed for v1.9.0-ocv.2.3",
    "[ci]: GitHub release failed for v1.9.0-ocv.2.3",
    "[ci]: Homebrew tap update failed for v1.9.0-ocv.2.3",
  ])
})

unix("dry-run is the safe default and only literal false enables gh", async () => {
  await using f = await fixture([issue(267, sync)])
  for (const value of [undefined, "true", "FALSE", "0", ""]) {
    expect((await f.run({ OCV_ISSUE_DRY_RUN: value })).code).toBe(0)
    expect((await f.run({ ...dispatch, OCV_ISSUE_DRY_RUN: value })).code).toBe(0)
  }
  expect((await f.read()).calls).toEqual([])
})

unix("skipped and cancelled channels cause no operations, nor does empty recovery", async () => {
  await using f = await fixture()
  expect(
    (
      await f.run({
        ...release,
        OCV_ISSUE_NPM: "skipped",
        OCV_ISSUE_HOMEBREW: "cancelled",
        OCV_ISSUE_GITHUB: "failure",
      })
    ).code,
  ).toBe(0)
  const before = (await f.read()).calls.length
  expect(
    (
      await f.run({
        ...release,
        OCV_ISSUE_NPM: "cancelled",
        OCV_ISSUE_HOMEBREW: "skipped",
        OCV_ISSUE_GITHUB: "failure",
      })
    ).code,
  ).toBe(0)
  expect(
    (await f.read()).calls
      .slice(before)
      .filter((args) => args.includes("channel:npm") || args.includes("channel:homebrew")),
  ).toEqual([])
  expect((await f.run({ OCV_ISSUE_RESULT: "success" })).code).toBe(0)
  expect((await f.read()).calls.at(-1)?.[0]).toBe("api")
})

unix("invalid major/ref/repository/run/server/status/version refuse before gh", async () => {
  await using f = await fixture()
  for (const overrides of [
    { OCV_ISSUE_MAJOR: "v3" },
    { GITHUB_REF: "refs/heads/ocv1" },
    { GITHUB_REF: "refs/pull/1/merge" },
    { GITHUB_REPOSITORY: "anomalyco/opencode" },
    { GITHUB_RUN_ID: "1;echo bad" },
    { GITHUB_SERVER_URL: "https://elsewhere.test" },
    { OCV_ISSUE_RESULT: "skipped" },
    { OCV_ISSUE_WORKFLOW: "other" },
    { OCV_ISSUE_NPM: "pending" },
    ...[undefined, "1.2.3-ocv.1.2", "2.1.0", "2.1.0-ocv.1", "2.01.0-ocv.1.2", "2.1.0-ocv.1.2+bad"].map((value) => ({
      ...release,
      OCV_ISSUE_VERSION: value,
    })),
  ]) {
    const result = await f.run(overrides)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Invalid")
  }
  expect((await f.read()).calls).toEqual([])
})

test("ownership is major-scoped even when an issue has the same title", () => {
  for (const major of ["v1", "v2"] as const) {
    const input = context({
      ...base,
      OCV_ISSUE_MAJOR: major,
      GITHUB_REF: `refs/heads/${major === "v1" ? "ocv1" : "ocv"}`,
    })
    const tracker = plan(input)[0]!
    expect(owns({ number: 267, title: tracker.title, labels: [] }, tracker, major)).toBe(true)
    expect(owns({ number: 267, title: tracker.legacy, labels: [major] }, tracker, major)).toBe(true)
    expect(owns({ number: 267, title: tracker.title, labels: [major === "v1" ? "v2" : "v1"] }, tracker, major)).toBe(
      false,
    )
    expect(owns({ number: 267, title: "unrelated", labels: [major] }, tracker, major)).toBe(false)
  }
})
