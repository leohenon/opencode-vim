type Result = "success" | "failure"
type Status = Result | "skipped" | "cancelled"
type Major = "v1" | "v2"
type Issue = { number: number; title: string; labels: string[] }
type Tracker = { title: string; legacy: string; labels: string[]; result: Result }

export function context(env: Record<string, string | undefined>) {
  const major = env.OCV_ISSUE_MAJOR
  const workflow = env.OCV_ISSUE_WORKFLOW
  const result = env.OCV_ISSUE_RESULT
  if (major !== "v1" && major !== "v2") throw new Error("Invalid OCV_ISSUE_MAJOR")
  if (workflow !== "sync" && workflow !== "release" && workflow !== "sync-dispatch")
    throw new Error("Invalid OCV_ISSUE_WORKFLOW")
  if (
    workflow === "sync-dispatch" &&
    (major !== "v1" ||
      env.GITHUB_WORKFLOW_REF !== "leohenon/opencode-vim/.github/workflows/sync-upstream-v1.yml@refs/heads/ocv")
  )
    throw new Error("Invalid sync-dispatch scope")
  if (result !== "success" && result !== "failure") throw new Error("Invalid OCV_ISSUE_RESULT")
  if (env.GITHUB_REPOSITORY !== "leohenon/opencode-vim") throw new Error("Invalid GITHUB_REPOSITORY")
  if (env.GITHUB_REF !== `refs/heads/${major === "v1" && workflow !== "sync-dispatch" ? "ocv1" : "ocv"}`)
    throw new Error("Invalid GITHUB_REF")
  if (env.GITHUB_SERVER_URL !== "https://github.com") throw new Error("Invalid GITHUB_SERVER_URL")
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? "")) throw new Error("Invalid GITHUB_RUN_ID")
  const version = env.OCV_ISSUE_VERSION ?? ""
  // Accept the release tag or its bare version, but always render exactly one leading v.
  if (
    workflow === "release" &&
    !new RegExp(`^v?${major.slice(1)}\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)-ocv\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$`).test(
      version,
    )
  ) {
    throw new Error("Invalid OCV_ISSUE_VERSION")
  }
  return {
    major,
    workflow,
    result,
    version: version.replace(/^v/, ""),
    channels: {
      npm: status(env.OCV_ISSUE_NPM),
      github: status(env.OCV_ISSUE_GITHUB),
      homebrew: status(env.OCV_ISSUE_HOMEBREW),
    },
    runURL: `https://github.com/leohenon/opencode-vim/actions/runs/${env.GITHUB_RUN_ID}`,
    dryRun: env.OCV_ISSUE_DRY_RUN !== "false",
  } as const
}

function status(value: string | undefined): Status {
  if (value === undefined) return "skipped"
  if (value === "success" || value === "failure" || value === "skipped" || value === "cancelled") return value
  throw new Error("Invalid channel status")
}

export function plan(input: ReturnType<typeof context>): Tracker[] {
  const labels = ["ci", input.major, `workflow:${input.workflow}`]
  const tracker = (text: string, result: Result, channel?: string): Tracker => ({
    title: `[ci]: ${text}`,
    legacy: `[actions]: ${text}`,
    labels: channel ? [...labels, `channel:${channel}`] : labels,
    result,
  })
  if (input.workflow === "sync-dispatch") return [tracker("sync upstream v1 dispatch failed", input.result)]
  if (input.workflow === "sync") {
    return [tracker(`sync upstream${input.major === "v1" ? " v1" : ""} failed`, input.result)]
  }
  const channels = Object.entries(input.channels).flatMap(([channel, result]) => {
    if (result !== "success" && result !== "failure") return []
    const name = channel === "npm" ? "npm publish" : channel === "homebrew" ? "Homebrew tap update" : "GitHub release"
    return [tracker(`${name} failed for v${input.version}`, result, channel)]
  })
  if (input.result === "success" || !Object.values(input.channels).includes("failure")) {
    channels.push(tracker(`release failed for v${input.version}`, input.result))
  }
  return channels
}

export function owns(issue: Issue, tracker: Tracker, major: Major) {
  return (
    (issue.title === tracker.title || issue.title === tracker.legacy) &&
    !issue.labels.includes(major === "v1" ? "v2" : "v1")
  )
}

async function runGh(args: string[]) {
  const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

async function gh(args: string[]) {
  const result = await runGh(args)
  if (result.code !== 0) throw new Error(`gh ${args[0]} failed (${result.code}): ${result.stderr}`)
  return result.stdout
}

// gh api --paginate --slurp returns an array of pages. Decode only at this boundary.
function pages(text: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value) || !value.every((page: unknown) => Array.isArray(page)))
    throw new Error("Invalid GitHub pages")
  return value.flatMap((page: unknown[]) =>
    page.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid GitHub record")
      return item as Record<string, unknown>
    }),
  )
}

function label(value: unknown): string {
  if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string")
    throw new Error("Invalid GitHub label")
  return value.name
}

function issues(text: string): Issue[] {
  return pages(text)
    .filter((item) => !item.pull_request)
    .map((item) => {
      if (
        !Number.isSafeInteger(item.number) ||
        Number(item.number) <= 0 ||
        typeof item.title !== "string" ||
        !Array.isArray(item.labels)
      )
        throw new Error("Invalid GitHub issue")
      return { number: Number(item.number), title: item.title, labels: item.labels.map(label) }
    })
}

export async function report(env: Record<string, string | undefined> = process.env) {
  const input = context(env)
  const trackers = plan(input)
  if (input.dryRun || trackers.length === 0) return
  const repo = "leohenon/opencode-vim"
  const open = issues(await gh(["api", "--paginate", "--slurp", `repos/${repo}/issues?state=open&per_page=100`]))
  const active = trackers.filter(
    (tracker) => tracker.result === "failure" || open.some((issue) => owns(issue, tracker, input.major)),
  )
  if (active.length === 0) return
  const labels = pages(await gh(["api", "--paginate", "--slurp", `repos/${repo}/labels?per_page=100`])).map(label)
  for (const name of new Set(active.flatMap((tracker) => tracker.labels))) {
    // Never use --force: existing label metadata belongs to the repository.
    if (labels.includes(name)) continue
    const created = await runGh(["label", "create", name, "--repo", repo])
    if (created.code === 0) continue
    // Another reporter may have created this shared label after our snapshot.
    const existing = await runGh(["api", `repos/${repo}/labels/${encodeURIComponent(name)}`])
    if (existing.code === 0 && label(JSON.parse(existing.stdout)) === name) continue
    throw new Error(`gh label failed (${created.code}): ${created.stderr}`)
  }
  for (const tracker of active) {
    const matching = open.filter((issue) => owns(issue, tracker, input.major)).sort((a, b) => a.number - b.number)
    const flags = tracker.labels.flatMap((name) => ["--add-label", name])
    if (tracker.result === "success") {
      for (const issue of matching) {
        await gh(["issue", "edit", String(issue.number), "--repo", repo, ...flags])
        await gh(["issue", "close", String(issue.number), "--repo", repo])
        await gh(["issue", "comment", String(issue.number), "--repo", repo, "--body", `Recovered: ${input.runURL}`])
      }
      continue
    }
    const body = `Workflow failure: ${input.runURL}`
    if (matching.length > 0) {
      await gh([
        "issue",
        "edit",
        String(matching[0].number),
        "--repo",
        repo,
        "--title",
        tracker.title,
        "--body",
        body,
        ...flags,
      ])
      continue
    }
    await gh([
      "issue",
      "create",
      "--repo",
      repo,
      "--title",
      tracker.title,
      "--body",
      body,
      ...tracker.labels.flatMap((name) => ["--label", name]),
    ])
  }
}

if (import.meta.main) await report()
