import { expect, test } from "bun:test"
import { planRelease } from "../script/ocv-release"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"
import { initGit } from "../../core/test/fixture/git"

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/sync-upstream.yml", import.meta.url)).text(),
) as { jobs: { sync: { steps: { name?: string; run?: string }[] } } }
const script = workflow.jobs.sync.steps.find((step) => step.name === "Merge upstream/dev")!.run!
const unix = process.platform === "win32" ? test.skip : test

unix.each(["tagged", "already-synced", "untagged", "non-v2"] as const)(
  "V2 dev sync with tag eligibility: %s",
  async (scenario) => {
    await using directory = await tmpdir()
    const upstream = path.join(directory.path, "upstream")
    const fork = path.join(directory.path, "fork")
    const env = isolatedEnv(directory.path, {
      RUNNER_TEMP: directory.path,
      GITHUB_OUTPUT: path.join(directory.path, "outputs"),
      HUSKY: "0",
    })
    const git = async (cwd: string, ...args: string[]) => {
      const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      return stdout.trim()
    }
    await mkdir(upstream)
    await initGit(upstream, "-b", "dev")
    await mkdir(path.join(upstream, "packages/core"), { recursive: true })
    await mkdir(path.join(upstream, ".github"))
    for (const file of ["AGENTS.md", "README.md", "install.sh", ".github/ocv-track"])
      await Bun.write(path.join(upstream, file), "fixture\n")
    const commit = async (version: string) => {
      await Bun.write(path.join(upstream, "packages/core/package.json"), JSON.stringify({ version }))
      await git(upstream, "add", ".")
      await git(upstream, "commit", "-m", version)
    }
    await commit("2.1.9")
    await git(directory.path, "clone", upstream, fork)
    await git(upstream, "tag", "v2.1.9")
    await commit("2.1.10")
    await git(upstream, "tag", "-a", "v2.1.10", "-m", "annotated V2 tag")
    // Dev work after the release tag is intentionally included in the fork build.
    await Bun.write(path.join(upstream, "newer-dev-work.txt"), "extra upstream work\n")
    await commit(scenario === "untagged" ? "2.1.12" : scenario === "non-v2" ? "1.99.0" : "2.1.10")
    await git(upstream, "tag", "v2.1.12-beta.1")
    await git(upstream, "tag", "v1.99.0")
    if (scenario === "already-synced") {
      await git(fork, "fetch", "origin", "dev")
      await git(fork, "merge", "--ff-only", "origin/dev")
    }
    const child = Bun.spawn(
      ["bash", "-euo", "pipefail", "-c", script.replace("https://github.com/anomalyco/opencode.git", upstream)],
      {
        cwd: fork,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (scenario === "non-v2") {
      expect(code).not.toBe(0)
      expect(stderr).toContain("Refusing non-V2 upstream source")
      return
    }
    expect(code, stdout + stderr).toBe(0)
    const source = await Bun.file(path.join(fork, "packages/core/package.json")).json()
    expect(source.version).toBe(scenario === "untagged" ? "2.1.12" : "2.1.10")
    expect(await Bun.file(path.join(fork, "newer-dev-work.txt")).text()).toBe("extra upstream work\n")
    if (scenario !== "already-synced")
      expect(await git(fork, "log", "-1", "--format=%s")).toBe("chore(upstream): sync upstream dev")
    const tags = await Bun.file(path.join(directory.path, "upstream-tags.json")).json()
    expect(tags).toEqual(["v2.1.10", "v2.1.9"])
    expect(
      planRelease({
        base: source.version,
        track: "4.13",
        forkChanges: false,
        upstream: tags,
        releases: [],
      }),
    ).toMatchObject({
      publish: scenario !== "untagged",
      reason: scenario === "untagged" ? "upstream-not-tagged" : "release-needed",
      version: `${source.version}-ocv.4.13`,
    })
  },
)
