import { previousRelease } from "./ocv-release"

export type Change = {
  kind: "pr" | "commit"
  ref: string
  title: string
  url: string
  author?: string
}

export type Commit = {
  sha: string
  parents: string[]
  name: string
  email: string
  subject: string
}

type Pull = {
  number: number
  title: string
  html_url: string
  merged_at: string | null
  base: { ref: string }
  user: { login: string } | null
}

export type Api = (path: string) => Promise<unknown>

// Direct commits for release bookkeeping and maintenance stay out of the notes. Merged PRs are always listed.
const maintenanceTypes = new Set(["chore", "ci", "test", "build"])
const maintenanceScopes = new Set(["ci", "test", "release", "upstream"])

export function maintenance(subject: string) {
  const match = subject.match(/^(\w+)(?:\(([^)]*)\))?!?:/)
  if (!match) return false
  return maintenanceTypes.has(match[1]!) || maintenanceScopes.has(match[2] ?? "")
}

function bot(commit: Commit) {
  return /\[bot\]/.test(commit.name) || /\[bot\]@/.test(commit.email)
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

/** Commits made on the fork branch itself, oldest first. Upstream history only enters through merge parents. */
export function forkCommits(cwd: string, from: string, to: string): Commit[] {
  return git(cwd, "log", "--first-parent", "--reverse", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%s%x1e", `${from}..${to}`)
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, name, email, subject] = record.split("\x1f")
      return { sha: sha!, parents: parents!.split(" ").filter(Boolean), name: name!, email: email!, subject: subject! }
    })
}

export async function collectChanges(input: {
  commits: readonly Commit[]
  repo: string
  branch?: string
  api: Api
}): Promise<Change[]> {
  const branch = input.branch ?? "ocv"
  const seen = new Set<number>()
  const changes: Change[] = []
  for (const commit of input.commits) {
    const pulls = (await input.api(`repos/${input.repo}/commits/${commit.sha}/pulls`)) as Pull[]
    const pull = pulls.find((item) => item.base.ref === branch && item.merged_at !== null)
    if (pull) {
      if (seen.has(pull.number)) continue
      seen.add(pull.number)
      changes.push({
        kind: "pr",
        ref: `#${pull.number}`,
        title: pull.title,
        url: pull.html_url,
        author: pull.user?.login,
      })
      continue
    }
    if (commit.parents.length > 1 || bot(commit) || maintenance(commit.subject)) continue
    const info = (await input.api(`repos/${input.repo}/commits/${commit.sha}`)) as { author: { login: string } | null }
    changes.push({
      kind: "commit",
      ref: commit.sha.slice(0, 7),
      title: commit.subject,
      url: `https://github.com/${input.repo}/commit/${commit.sha}`,
      author: info.author?.login,
    })
  }
  return changes
}

/** Escape HTML outside code spans; release notes render inside <details>, where a bare <leader> would vanish. */
function escape(text: string) {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith("`") ? part : part.replaceAll("<", "&lt;").replaceAll(">", "&gt;")))
    .join("")
}

export function renderNotes(input: { version: string; previous?: string; changes: readonly Change[]; repo: string }) {
  const match = input.version.match(/^(\d+\.\d+\.\d+)-ocv\.(\d+\.\d+)$/)
  if (!match) throw new Error(`Invalid OCV version: ${input.version}`)
  const lines = [`based on opencode v${match[1]}`, "", `ocv patch ${match[2]}`]
  if (input.changes.length) {
    const entries = input.changes.map(
      (change) =>
        `${escape(change.title)} - [${change.ref}](${change.url})${change.author ? ` (@${change.author})` : ""}`,
    )
    lines.push(
      "",
      "<details>",
      `<summary>All changes (${entries.length})</summary>`,
      "",
      // A trailing backslash keeps each entry on its own line inside the HTML block.
      ...entries.map((entry, index) => (index < entries.length - 1 ? `${entry}\\` : entry)),
      "",
      "</details>",
    )
  }
  if (input.previous)
    lines.push("", `**Full Changelog**: https://github.com/${input.repo}/compare/${input.previous}...v${input.version}`)
  return lines.join("\n") + "\n"
}

/** The newest V2 release tag reachable from the release source, excluding the version being released. */
export function previousTag(cwd: string, version: string, head = "HEAD") {
  const tags = git(cwd, "tag", "--merged", head, "--list", "v2.*")
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag && tag !== `v${version}`)
  return previousRelease(tags.map((tagName) => ({ tagName, isDraft: false })))
}

const ghApi: Api = async (path) => {
  const result = Bun.spawnSync(["gh", "api", path], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`gh api ${path} failed: ${result.stderr.toString()}`)
  return JSON.parse(result.stdout.toString())
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error("GITHUB_REPOSITORY is required")
  const cwd = process.cwd()
  if (command === "changes" && args.length === 2) {
    const commits = forkCommits(cwd, args[0]!, args[1]!)
    console.log(JSON.stringify(await collectChanges({ commits, repo, api: ghApi })))
  } else if (command === "notes" && args.length >= 1) {
    const version = args[0]!
    const head = args[1] ?? "HEAD"
    const previous = previousTag(cwd, version, head)
    const changes = previous
      ? await collectChanges({ commits: forkCommits(cwd, previous, head), repo, api: ghApi })
      : []
    process.stdout.write(renderNotes({ version, previous, changes, repo }))
  } else {
    throw new Error("Usage: ocv-notes.ts changes <from> <to> | notes <version> [head]")
  }
}
