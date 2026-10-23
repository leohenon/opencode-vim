import { describe, expect, test } from "bun:test"
import { chmod, mkdir } from "fs/promises"
import path from "path"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const root = path.resolve(import.meta.dir, "../../..")
type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown> }
type Workflow = {
  on: Record<string, { branches?: string[]; inputs?: Record<string, { default?: boolean }> }>
  env?: Record<string, string>
  jobs: Record<string, { if?: string | boolean; needs?: string | string[]; steps?: Step[]; "runs-on"?: string }>
}
const files = await Array.fromAsync(new Bun.Glob("*.yml").scan({ cwd: path.join(root, ".github/workflows") }))
const workflows = Object.fromEntries(
  await Promise.all(
    files.map(
      async (file) =>
        [file, Bun.YAML.parse(await Bun.file(path.join(root, ".github/workflows", file)).text()) as Workflow] as const,
    ),
  ),
)
const publish = workflows["publish-ocv.yml"]!
const sync = workflows["sync-upstream.yml"]!

function step(workflow: Workflow, name: string) {
  const found = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((item) => item.name === name)
  if (!found) throw new Error(`Missing workflow step: ${name}`)
  return found
}

describe("V1 workflow isolation", () => {
  test.each(["ci.yml", "typecheck.yml", "test.yml", "storybook.yml", "nix-eval.yml"])(
    "%s checks only the V1 maintenance branch",
    (file) => {
      expect(workflows[file]!.on.push?.branches).toEqual(["ocv1"])
      expect(workflows[file]!.on.pull_request?.branches).toEqual(["ocv1"])
      Object.values(workflows[file]!.jobs).forEach((job) => expect(job.if).toContain("leohenon/opencode-vim"))
    },
  )

  test("V1 cannot deploy Pages over the V2 site", () => {
    expect(files).not.toContain("ocv-pages.yml")
    expect(
      Object.values(workflows)
        .flatMap((workflow) => Object.values(workflow.jobs))
        .flatMap((job) => job.steps ?? [])
        .some((item) => item.uses?.startsWith("actions/deploy-pages@")),
    ).toBe(false)
  })

  test("all inherited mutation jobs remain upstream-only", () => {
    const owned = [
      "ci.yml",
      "typecheck.yml",
      "test.yml",
      "storybook.yml",
      "nix-eval.yml",
      "nix-hashes.yml",
      "publish-ocv.yml",
      "sync-upstream.yml",
      "pr-standards.yml",
    ]
    Object.entries(workflows)
      .filter(([file]) => !owned.includes(file))
      .forEach(([file, workflow]) => {
        Object.entries(workflow.jobs).forEach(([name, job]) => {
          if (file === "pr-management.yml" && name === "add-contributor-label") {
            expect(job.if).toContain("leohenon/opencode-vim")
            expect(job.if).toContain("ocv1")
            return
          }
          if (job.if === false) return
          expect(String(job.if), `${file}/${name}`).toMatch(/github\.repository == '(anomalyco|sst)\/opencode'/)
        })
      })
  })

  test("sync is V1-only and never disables repository-wide workflows", () => {
    expect(sync.on.schedule).toBeUndefined()
    expect(sync.on.workflow_dispatch?.inputs?.dry_run?.default).toBe(true)
    expect(sync.jobs.sync!.if).toContain("refs/heads/ocv1")
    const runs = sync.jobs.sync!.steps!.map((item) => item.run ?? "").join("\n")
    expect(runs).toContain("git fetch upstream v1")
    expect(runs).not.toContain("upstream/dev")
    expect(runs).not.toContain("/disable")
    expect(step(sync, "Push synchronized V1 branch").if).toBe("inputs.dry_run == false")
    expect(step(sync, "Trigger V1 release").run).toContain("--ref ocv1")
    expect(step(sync, "Trigger V1 release").run).toContain("-f dry_run=false")
    expect(step(sync, "Pin V1 release source").run).toContain('git merge-base --is-ancestor "$sha" HEAD')
  })

  test("release pins V1 source, stable npm channel and safe manual defaults", () => {
    expect(publish.on.workflow_dispatch?.inputs?.dry_run?.default).toBe(true)
    expect(publish.jobs.prepare!.if).toContain("refs/heads/ocv1")
    expect(publish.env?.OCV_NPM_TAG).toBe("latest")
    expect(publish.jobs.release!["runs-on"]).toBe("macos-latest")
    expect(step(publish, "Validate version").run).toContain('"$BASE-ocv.$TRACK"')
    expect(step(publish, "Validate version").run).toContain("HEAD origin/ocv1")
    expect(step(publish, "Verify immutable release source").run).toContain("refs/tags/v$VERSION^{commit}")
    expect(step(publish, "Create GitHub Release").if).toBe("inputs.dry_run == false")
    expect(step(publish, "Create GitHub Release").run).toContain("--prerelease=false --latest=true")
  })

  test("dry runs cannot push Nix/contributor changes or mutate releases, tap or issues", () => {
    Object.values(publish.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((item) => /git push|gh (release (create|edit|upload)|issue (create|edit|close))/.test(item.run ?? ""))
      .forEach((item) => {
        expect(item.if, item.name).toMatch(
          /inputs\.dry_run == false|steps\.(checkout_tap|update_formula|push_formula)\.outcome/,
        )
      })
    expect(step(publish, "Checkout tap").if).toBe("inputs.dry_run == false")
    expect(step(publish, "Update formula").if).toContain("inputs.dry_run ||")
    expect(step(publish, "Update formula").run).toContain("ruby -c")
    expect(step(publish, "Pack or publish V1 npm package").run).toContain("publish-ocv-npm.ts")
    expect(step(publish, "Upload dry-run artifacts").if).toContain("inputs.dry_run")
  })

  test("release uses the source Bun pin and does not trust upstream-merge Nix hashes", () => {
    expect(
      Object.values(publish.jobs)
        .flatMap((job) => job.steps ?? [])
        .some((item) => item.uses === "./.github/actions/setup-bun"),
    ).toBe(true)
    expect(step(publish, "Detect Nix hash state").run).toContain("git log --first-parent --no-merges")
    expect(step(publish, "Detect Nix hash state").run).toContain("nix/hashes.json")
  })

  test("Nix automation follows the three systems supported by the upstream V1 flake", async () => {
    for (const file of ["publish-ocv.yml", "nix-hashes.yml", "nix-eval.yml"]) {
      const text = await Bun.file(path.join(root, ".github/workflows", file)).text()
      expect(text).not.toContain("x86_64-darwin")
      for (const system of ["x86_64-linux", "aarch64-linux", "aarch64-darwin"]) expect(text).toContain(system)
    }
    expect(Object.keys((await Bun.file(path.join(root, "nix/hashes.json")).json()).nodeModules).sort()).toEqual([
      "aarch64-darwin",
      "aarch64-linux",
      "x86_64-linux",
    ])
  })

  test("V1 Homebrew never stages or edits the V2 formula", () => {
    expect(step(publish, "Update formula").run).toContain("tap/Formula/ocv.rb")
    expect(step(publish, "Update formula").run).toContain('conflicts_with "ocv-v2"')
    expect(step(publish, "Push formula").run).toContain("git add Formula/ocv.rb")
    expect(step(publish, "Push formula").run).not.toContain("git add .")
  })
})

// These execute the real workflow gate; Windows does not provide POSIX bash/jq.
describe.skipIf(process.platform === "win32")("V1 release admission shell", () => {
  test.each([
    ["1.18.35-ocv.4.13", "refs/heads/ocv1", false, true, ""],
    ["1.18.35-ocv.4.13", "refs/heads/ocv1", false, false, "v1.19.0-ocv.4.13"],
    ["1.18.35-ocv.4.13", "refs/heads/ocv1", false, true, "v2.1.2-ocv.4.13"],
    ["2.1.2-ocv.4.13", "refs/heads/ocv1", false, false, ""],
    ["1.18.34-ocv.4.13", "refs/heads/ocv1", false, false, ""],
    ["1.18.35-ocv.4.14", "refs/heads/ocv1", false, false, ""],
    ["1.18.35-ocv.4.13", "refs/heads/ocv", false, false, ""],
    ["1.18.35-ocv.4.13", "refs/heads/ocv1", true, false, ""],
  ] as const)("validates %s on %s, conflicting tag %s", async (version, ref, conflicting, accepted, previous) => {
    await using dir = await tmpdir()
    await mkdir(path.join(dir.path, "shims"))
    await mkdir(path.join(dir.path, ".github"))
    await mkdir(path.join(dir.path, "packages/opencode"), { recursive: true })
    await Bun.write(path.join(dir.path, ".github/ocv-track"), "4.13\n")
    await Bun.write(path.join(dir.path, "packages/opencode/package.json"), '{"version":"1.18.35"}\n')
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: dir.path })
      expect(result.stderr.toString(), `git ${args.join(" ")}`).not.toContain("fatal:")
      expect(result.exitCode).toBe(0)
      return result.stdout.toString().trim()
    }
    git("init", "-b", "ocv1")
    await Bun.write(
      path.join(dir.path, ".git/config"),
      (await Bun.file(path.join(dir.path, ".git/config")).text()) +
        "\n[user]\nname = Fixture\nemail = fixture@example.com\n[commit]\ngpgsign = false\n[core]\nhooksPath = /dev/null\nfsmonitor = false\n",
    )
    git("add", ".")
    git("commit", "-m", "fixture")
    if (conflicting) {
      git("tag", `v${version}`)
      git("commit", "--allow-empty", "-m", "different source")
    }
    git("update-ref", "refs/remotes/origin/ocv1", "HEAD")
    await Bun.write(
      path.join(dir.path, "shims/gh"),
      `#!/bin/sh\nif [ "$1 $2" = "release list" ]; then printf '%s\\n' "$FIXTURE_RELEASES"; exit 0; fi\necho "Unexpected remote operation" >&2\nexit 1\n`,
    )
    await chmod(path.join(dir.path, "shims/gh"), 0o755)
    const result = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", step(publish, "Validate version").run!], {
      cwd: dir.path,
      env: {
        ...process.env,
        VERSION: version,
        FIXTURE_RELEASES: JSON.stringify(previous ? [{ tagName: previous, isDraft: false, isPrerelease: false }] : []),
        GITHUB_REF: ref,
        GITHUB_REPOSITORY: "leohenon/opencode-vim",
        RUNNER_TEMP: dir.path,
        PATH: path.join(dir.path, "shims") + path.delimiter + process.env.PATH,
      },
    })
    expect(result.exitCode === 0, result.stdout.toString() + result.stderr.toString()).toBe(accepted)
  })
})
