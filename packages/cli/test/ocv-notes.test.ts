import { describe, expect, test } from "bun:test"
import { chmod, mkdir } from "node:fs/promises"
import { devNull } from "node:os"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"
import { initGit } from "../../core/test/fixture/git"
import {
  collectChanges,
  forkCommits,
  maintenance,
  previousTag,
  renderNotes,
  type Api,
  type Commit,
} from "../script/ocv-notes"

const repo = "leohenon/opencode-vim"
const read = async (name: string) =>
  Bun.YAML.parse(await Bun.file(new URL(`../../../.github/workflows/${name}`, import.meta.url)).text()) as {
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>
  }
const run = (workflow: Awaited<ReturnType<typeof read>>, name: string) =>
  Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .find((step) => step.name === name)!.run!

const commit = (sha: string, subject: string, input: Partial<Commit> = {}): Commit => ({
  sha: sha.padEnd(40, "0"),
  parents: ["p".padEnd(40, "0")],
  name: "Leo",
  email: "leo@example.com",
  subject,
  ...input,
})
const pull = (number: number, title: string, base = "ocv", login = "alice") => ({
  number,
  title,
  html_url: `https://github.com/${repo}/pull/${number}`,
  merged_at: "2026-11-20T00:00:00Z",
  base: { ref: base },
  user: { login },
})
const api =
  (pulls: Record<string, unknown[]>, logins: Record<string, string | null> = {}): Api =>
  async (url) => {
    const sha = url.split("/commits/")[1]!.split("/")[0]!
    if (url.endsWith("/pulls")) return pulls[sha] ?? []
    const login = logins[sha] === undefined ? "leohenon" : logins[sha]
    return { author: login ? { login } : null }
  }

describe("OCV release notes", () => {
  test.each([
    ["chore(release): bump ocv track", true],
    ["chore(upstream): sync upstream dev", true],
    ["ci: rename workflows", true],
    ["test(tui): add mock", true],
    ["fix(ci): preserve workflows", true],
    ["fix(test): isolate Git identity", true],
    ["feat(vim): add motion", false],
    ["fix: preserve footer compatibility", false],
    ["docs: clarify installation", false],
    ["update readme", false],
  ])("classifies %s as maintenance=%s", (subject, expected) => {
    expect(maintenance(subject)).toBe(expected)
  })

  test("lists merged PRs into ocv once and direct fork commits, skipping merges, bots and maintenance", async () => {
    const commits = [
      commit("a1", "feat(vim): add motion part 1"),
      commit("a2", "feat(vim): add motion part 2"),
      commit("b1", "chore(upstream): sync upstream dev", { parents: ["x".padEnd(40, "0"), "y".padEnd(40, "0")] }),
      commit("c1", "chore(release): bump ocv track", { name: "github-actions[bot]" }),
      commit("d1", "fix(ci): preserve workflows"),
      commit("e1", "fix(copy): keep wide characters visible"),
      commit("f1", "docs: ocv1 only", {}),
      commit("g1", "fix: by someone without a GitHub account"),
    ]
    const changes = await collectChanges({
      commits,
      repo,
      api: api(
        {
          [commits[0]!.sha]: [pull(12, "feat(vim): add motion")],
          [commits[1]!.sha]: [pull(12, "feat(vim): add motion")],
          [commits[6]!.sha]: [pull(13, "docs: ocv1 only", "ocv1")],
        },
        { [commits[7]!.sha]: null },
      ),
    })
    expect(changes).toEqual([
      {
        kind: "pr",
        ref: "#12",
        title: "feat(vim): add motion",
        url: `https://github.com/${repo}/pull/12`,
        author: "alice",
      },
      {
        kind: "commit",
        ref: commits[5]!.sha.slice(0, 7),
        title: "fix(copy): keep wide characters visible",
        url: `https://github.com/${repo}/commit/${commits[5]!.sha}`,
        author: "leohenon",
      },
      {
        kind: "commit",
        ref: commits[6]!.sha.slice(0, 7),
        title: "docs: ocv1 only",
        url: `https://github.com/${repo}/commit/${commits[6]!.sha}`,
        author: "leohenon",
      },
      {
        kind: "commit",
        ref: commits[7]!.sha.slice(0, 7),
        title: "fix: by someone without a GitHub account",
        url: `https://github.com/${repo}/commit/${commits[7]!.sha}`,
        author: undefined,
      },
    ])
  })

  test("renders the based-on header, a collapsible change list and the full changelog", () => {
    const notes = renderNotes({
      version: "2.3.1-ocv.4.16",
      previous: "v2.3.0-ocv.4.15",
      repo,
      changes: [
        {
          kind: "pr",
          ref: "#12",
          title: "feat: add <leader>y and `<leader>p`",
          url: "https://x/pull/12",
          author: "alice",
        },
        { kind: "commit", ref: "abc1234", title: "fix: no account", url: "https://x/commit/abc1234" },
      ],
    })
    expect(notes).toBe(
      [
        "based on opencode v2.3.1",
        "",
        "ocv patch 4.16",
        "",
        "<details>",
        "<summary>All changes (2)</summary>",
        "",
        "feat: add &lt;leader&gt;y and `<leader>p` - [#12](https://x/pull/12) (@alice)\\",
        "fix: no account - [abc1234](https://x/commit/abc1234)",
        "",
        "</details>",
        "",
        `**Full Changelog**: https://github.com/${repo}/compare/v2.3.0-ocv.4.15...v2.3.1-ocv.4.16`,
        "",
      ].join("\n"),
    )
  })

  test("upstream-only releases keep the header and changelog without an empty list", () => {
    expect(renderNotes({ version: "2.3.1-ocv.4.15", previous: "v2.3.0-ocv.4.15", repo, changes: [] })).toBe(
      "based on opencode v2.3.1\n\nocv patch 4.15\n\n" +
        `**Full Changelog**: https://github.com/${repo}/compare/v2.3.0-ocv.4.15...v2.3.1-ocv.4.15\n`,
    )
    expect(renderNotes({ version: "2.1.4-ocv.4.15", repo, changes: [] })).toBe(
      "based on opencode v2.1.4\n\nocv patch 4.15\n",
    )
    expect(() => renderNotes({ version: "1.19.4", repo, changes: [] })).toThrow("Invalid OCV version")
  })

  test("walks only fork commits and picks the newest earlier V2 tag", async () => {
    await using directory = await tmpdir()
    const root = directory.path
    const env = isolatedEnv(root, { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", HUSKY: "0" })
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      return result.stdout.toString().trim()
    }
    await initGit(root, "-b", "ocv")
    const empty = (message: string) => git("commit", "--allow-empty", "-m", message)
    empty("base")
    git("tag", "v2.1.4-ocv.4.9")
    git("tag", "v1.19.4-ocv.4.99")
    empty("between")
    git("tag", "v2.1.4-ocv.4.15")
    git("switch", "-q", "-c", "upstream")
    empty("upstream work")
    git("switch", "-q", "ocv")
    empty("feat: fork work")
    git("merge", "--no-ff", "-q", "-m", "chore(upstream): sync upstream dev", "upstream")
    empty("fix: after sync")
    git("tag", "v2.3.0-ocv.4.16")

    expect(previousTag(root, "2.3.0-ocv.4.16")).toBe("v2.1.4-ocv.4.15")
    expect(forkCommits(root, "v2.1.4-ocv.4.15", "HEAD").map((item) => [item.subject, item.parents.length])).toEqual([
      ["feat: fork work", 1],
      ["chore(upstream): sync upstream dev", 2],
      ["fix: after sync", 1],
    ])
  })

  const unix = process.platform === "win32" ? test.skip : test
  unix.each([
    ["fix(vim): keep cursors", "4.16"],
    ["fix(ci): rename workflows", "4.15"],
  ])("sync planning after %s releases ocv patch %s", async (subject, track) => {
    await using directory = await tmpdir()
    const root = directory.path
    const bin = path.join(root, ".bin")
    const env = {
      ...isolatedEnv(root, {
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: "1",
        HUSKY: "0",
        GITHUB_REPOSITORY: repo,
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: path.join(root, "outputs"),
      }),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    }
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      return result.stdout.toString().trim()
    }
    await initGit(root, "-b", "ocv")
    // The planner resolves the source version and track relative to its own script location.
    for (const name of ["ocv-release.ts", "ocv-notes.ts"])
      await Bun.write(
        path.join(root, "packages/cli/script", name),
        Bun.file(path.join(import.meta.dir, "../script", name)),
      )
    await Bun.write(path.join(root, "packages/core/package.json"), '{"version":"2.3.1"}\n')
    await Bun.write(path.join(root, ".github/ocv-track"), "4.15\n")
    git("add", ".")
    git("commit", "-m", "release source")
    git("tag", "v2.3.0-ocv.4.15")
    git("commit", "--allow-empty", "-m", subject)
    await Bun.write(path.join(root, "upstream-tags.json"), '["v2.3.1"]\n')
    await mkdir(bin)
    await Bun.write(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1 $2" in',
        '  "release list") echo \'[{"tagName":"v2.3.0-ocv.4.15","isDraft":false}]\' ;;',
        '  "api "*/pulls) echo "[]" ;;',
        '  "api "*) echo \'{"author":{"login":"leohenon"}}\' ;;',
        "  *) exit 99 ;;",
        "esac",
        "",
      ].join("\n"),
    )
    await chmod(path.join(bin, "gh"), 0o755)
    const sync = run(await read("sync-upstream.yml"), "Check V2 releases and fork revision")
    const child = Bun.spawn(["bash", "-euo", "pipefail", "-c", sync], {
      cwd: root,
      env: { ...env, BEFORE: git("rev-parse", "HEAD") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
    expect(await Bun.file(path.join(root, ".github/ocv-track")).text()).toBe(`${track}\n`)
    expect(await Bun.file(path.join(root, "outputs")).text()).toContain(`version=2.3.1-ocv.${track}\n`)
    expect(git("log", "-1", "--format=%s")).toBe(track === "4.16" ? "chore(release): bump ocv track" : subject)
  })

  test("sync bumps the patch from the same changes the notes list", async () => {
    const sync = run(await read("sync-upstream.yml"), "Check V2 releases and fork revision")
    expect(sync).toContain('bun run packages/cli/script/ocv-notes.ts changes "$previous" "$BEFORE"')
    expect(sync).not.toContain("/pulls")
  })

  test("publish writes the generated notes into the draft and marks the stable V2 release as Latest", async () => {
    const publish = await read("publish-ocv.yml")
    expect(run(publish, "Generate release notes")).toContain(
      'bun run packages/cli/script/ocv-notes.ts notes "$VERSION" > "$RUNNER_TEMP/ocv-release-notes.md"',
    )
    const stage = run(publish, "Stage or resume draft release")
    expect(stage).not.toContain("--generate-notes")
    expect(stage.match(/--notes-file "\$RUNNER_TEMP\/ocv-release-notes.md"/g)).toHaveLength(2)
    expect(run(publish, "Publish GitHub release after npm succeeds")).toBe(
      'gh release edit "v$VERSION" --draft=false --prerelease=false --latest=true',
    )
  })
})
