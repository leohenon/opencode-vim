import { describe, expect, test } from "bun:test"

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/pr-standards.yml", import.meta.url)).text(),
) as {
  on: { pull_request_target: { branches: string[] } }
  jobs: Record<string, { if: string; steps: { with: { script: string } }[] }>
}

const template = await Bun.file(new URL("../../../.github/pull_request_template.md", import.meta.url)).text()
const validBody = template
  .replace("Closes #", "Closes #123")
  .replace("- [ ] Bug fix", "- [x] Bug fix")
  .replace("Please provide a description of the issue", "Fixes the reported cursor regression")
  .replace(
    "### How did you verify your code works?",
    "### How did you verify your code works?\n\nRan the regression tests.",
  )
  .replaceAll("- [ ] I have", "- [x] I have")
const jobs = ["check-standards", "check-compliance"]

async function run(
  job: string,
  input: { base?: string; association?: string; login?: string; title?: string; body?: string } = {},
) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const record = (method: string, params: Record<string, unknown>) => calls.push({ method, params })
  const github = {
    rest: {
      repos: {
        getContent: async (params: Record<string, unknown>) => {
          record("getContent", params)
          return { data: { content: Buffer.from("upstream-maintainer\n").toString("base64") } }
        },
      },
      issues: {
        addLabels: async (params: Record<string, unknown>) => record("addLabels", params),
        removeLabel: async (params: Record<string, unknown>) => record("removeLabel", params),
        listComments: async (params: Record<string, unknown>) => {
          record("listComments", params)
          return { data: [] }
        },
        createComment: async (params: Record<string, unknown>) => record("createComment", params),
      },
    },
    graphql: async (_query: string, params: Record<string, unknown>) => {
      record("graphql", params)
      return { repository: { pullRequest: { closingIssuesReferences: { totalCount: 0 } } } }
    },
  }
  await new Function(
    "github",
    "context",
    "console",
    `return (async () => {\n${workflow.jobs[job].steps[0].with.script}\n})()`,
  )(
    github,
    {
      repo: { owner: "leohenon", repo: "opencode-vim" },
      payload: {
        pull_request: {
          number: 42,
          created_at: "2026-03-01T00:00:00Z",
          user: { login: input.login ?? "external-contributor" },
          author_association: input.association ?? "NONE",
          base: { ref: input.base ?? "ocv" },
          head: { ref: "untrusted-branch", repo: { full_name: "external/opencode-vim" } },
          title: input.title ?? "fix(tui): restore cursor",
          body: input.body ?? validBody,
          labels: [],
        },
      },
    },
    { log() {} },
  )
  return calls
}

describe("ocv PR standards workflow", () => {
  test("runs only for fork PRs targeting supported branches", () => {
    expect(workflow.on.pull_request_target.branches).toEqual(["ocv", "ocv1"])
    for (const job of jobs) {
      expect(workflow.jobs[job].if).toBe("github.repository == 'leohenon/opencode-vim'")
    }
  })

  for (const job of jobs) {
    test.each(["OWNER", "MEMBER", "COLLABORATOR"])(
      `${job} exempts %s before fetching membership`,
      async (association) => {
        expect(await run(job, { association, title: "bad title", body: "" })).toEqual([])
      },
    )

    test(`${job} exempts the OpenCode bot`, async () => {
      expect(await run(job, { login: "opencode-agent[bot]", title: "bad title", body: "" })).toEqual([])
    })

    test.each(["ocv", "ocv1"])(
      `${job} accepts a valid external PR against %s using trusted base membership`,
      async (base) => {
        const calls = await run(job, { base })
        expect(calls.filter((call) => call.method === "getContent").map((call) => call.params)).toEqual([
          { owner: "leohenon", repo: "opencode-vim", path: ".github/TEAM_MEMBERS", ref: base },
        ])
        expect(calls.some((call) => call.method === "addLabels" || call.method === "createComment")).toBe(false)
      },
    )
  }

  test.each(["ocv", "ocv1"])(
    "title and template violations still label and comment on the fork with %s links",
    async (base) => {
      for (const job of jobs) {
        const calls = await run(job, { base, title: "bad title", body: "" })
        expect(calls.find((call) => call.method === "addLabels")?.params.labels).toEqual([
          job === "check-standards" ? "needs:title" : "needs:compliance",
        ])
        const body = calls.find((call) => call.method === "createComment")?.params.body
        expect(body).toContain(`../blob/${base}/CONTRIBUTING.md`)
        if (job === "check-compliance") expect(body).toContain(`../blob/${base}/.github/pull_request_template.md`)
        expect(body).not.toContain("automatically closed")
        expect(body).not.toContain("72 hours")
        for (const call of calls) {
          expect(call.params.owner).toBe("leohenon")
          expect(call.params.repo).toBe("opencode-vim")
        }
      }
    },
  )

  test("a missing issue still labels and comments on the fork", async () => {
    const calls = await run("check-standards", {
      base: "ocv1",
      body: validBody.replace("Closes #123", "No linked issue"),
    })
    expect(calls.find((call) => call.method === "addLabels")?.params).toEqual({
      owner: "leohenon",
      repo: "opencode-vim",
      issue_number: 42,
      labels: ["needs:issue"],
    })
    expect(calls.find((call) => call.method === "createComment")?.params.body).toContain(
      "../blob/ocv1/CONTRIBUTING.md",
    )
  })
})
