import { describe, expect, test } from "bun:test"
import { chmod, mkdir } from "fs/promises"
import path from "path"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const root = path.resolve(import.meta.dir, "../../..")
type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown> }
type Workflow = {
  name: string
  "run-name": string
  on: Record<string, { branches?: string[]; inputs?: Record<string, { default?: boolean }> }>
  env?: Record<string, string>
  permissions?: Record<string, string>
  concurrency?: { group: string; "cancel-in-progress": boolean }
  jobs: Record<
    string,
    {
      if?: string | boolean
      needs?: string | string[]
      steps?: Step[]
      "runs-on"?: string
      env?: Record<string, string>
      permissions?: Record<string, string>
      outputs?: Record<string, string>
    }
  >
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
  test("sync names identify the V1 upstream while run names identify executions", () => {
    expect(sync.name).toBe("Sync ocv1 with upstream/v1")
    expect(publish.name).toBe("Release ocv")
    expect(sync["run-name"]).toBe("Sync ocv1 with upstream/v1")
    expect(publish["run-name"]).toBe("release v${{ inputs.version }}")
  })

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
    expect(step(sync, "Trigger V1 release").run).toContain(
      'gh workflow run publish-ocv.yml --repo "$GITHUB_REPOSITORY" --ref ocv1 ',
    )
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

  test("verification cannot replace queued publication in the concurrency group", () => {
    expect(publish.concurrency).toEqual({
      group: "release-ocv-v1-${{ inputs.dry_run && 'dry-run' || 'publish' }}",
      "cancel-in-progress": false,
    })
  })

  test.each([
    ["prepare-source", "update-nix-hashes"],
    ["release", "prepare-source"],
  ] as const)("%s gate accepts a successful %s despite skipped hash computation", (job, parent) => {
    expect(publish.jobs[job]!.needs).toBe(parent)
    const expression = String(publish.jobs[job]!.if)
    expect(expression).toContain("always() && !cancelled()")
    const gate = new Function(
      "needs",
      "always",
      "cancelled",
      `return (${expression.replaceAll(`needs.${parent}`, `needs["${parent}"]`)})`,
    )
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      for (const cancelled of [false, true]) {
        expect(
          gate(
            { "compute-nix-hash": { result: "skipped" }, [parent]: { result } },
            () => true,
            () => cancelled,
          ),
        ).toBe(result === "success" && !cancelled)
      }
    }
  })

  test("canonical release source is selected before validation and installation", () => {
    expect(publish.jobs.prepare!.steps!.slice(0, 3).map((item) => item.name ?? item.uses)).toEqual([
      "actions/checkout@v4",
      "Adopt existing release source",
      "Validate version",
    ])
    expect(publish.jobs["prepare-source"]!.steps!.slice(0, 4).map((item) => item.name ?? item.uses)).toEqual([
      "actions/checkout@v4",
      "Adopt prepared release source",
      "oven-sh/setup-bun@v2",
      "Add release contributors",
    ])
    expect(publish.jobs["prepare-source"]!.steps![0]!.with).toEqual({
      ref: "${{ needs.update-nix-hashes.outputs.sha }}",
      "fetch-depth": 0,
    })
    expect(publish.jobs["prepare-source"]!.steps![2]!.with).toEqual({ "bun-version": "1.4.4" })
    expect(publish.jobs["prepare-source"]!.steps!.some((item) => /install/.test(item.run ?? ""))).toBe(false)
    expect(publish.jobs["prepare-source"]!.outputs).toEqual({ sha: "${{ steps.source.outputs.sha }}" })
    expect(publish.jobs["prepare-source"]!.steps!.at(-1)).toMatchObject({
      name: "Set prepared source SHA",
      id: "source",
      run: 'echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"',
    })
    expect(publish.jobs.release!.steps![0]!.with).toEqual({
      ref: "${{ needs.prepare-source.outputs.sha }}",
      "fetch-depth": 0,
    })
    expect(publish.jobs.release!.steps!.slice(0, 3).map((item) => item.name ?? item.uses)).toEqual([
      "actions/checkout@v4",
      "Restore existing release source",
      "./.github/actions/setup-bun",
    ])
    expect(publish.jobs.release!.steps!.some((item) => item.name === "Add release contributors")).toBe(false)
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

  test.each(["sync", "release"] as const)("%s reports issues in a fresh, least-privileged job", (kind) => {
    const workflow = kind === "sync" ? sync : publish
    const reporter = workflow.jobs.issues!
    expect(workflow.permissions?.issues).toBeUndefined()
    expect(reporter.permissions).toEqual({ contents: "read", issues: "write" })
    expect(reporter["runs-on"]).toBe("ubuntu-latest")
    expect(reporter.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      OCV_ISSUE_MAJOR: "v1",
      OCV_ISSUE_WORKFLOW: kind,
      OCV_ISSUE_DRY_RUN: "${{ inputs.dry_run }}",
    })
    expect(reporter.steps).toEqual([
      {
        uses: "actions/checkout@v4",
        with: { ref: "${{ github.workflow_sha }}", "sparse-checkout": ".github/scripts" },
      },
      { uses: "oven-sh/setup-bun@v2", with: { "bun-version": "1.4.4" } },
      { name: "Report workflow issues", run: "bun .github/scripts/ocv-issues.ts" },
    ])
    expect(reporter.if).toContain("always() && !cancelled()")
    expect(reporter.if).toContain("github.repository == 'leohenon/opencode-vim'")
    expect(reporter.if).toContain("github.ref == 'refs/heads/ocv1'")
    expect(reporter.if).toContain("inputs.dry_run == false")
    const runs = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((item) => item.run ?? "")
      .join("\n")
    expect(runs).not.toMatch(/gh (issue|label) /)
    const names = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((item) => item.name)
    for (const name of [
      "Notify on failure",
      "Close failure issue on success",
      "Create Homebrew failure issue",
      "Close Homebrew failure issues",
      "Create npm failure issue",
      "Close npm failure issues",
    ])
      expect(names).not.toContain(name)
  })

  test.each([
    ["leohenon/opencode-vim", "refs/heads/ocv1", false, false, true],
    ["leohenon/opencode-vim", "refs/heads/ocv1", true, false, false],
    ["leohenon/opencode-vim", "refs/heads/ocv1", false, true, false],
    ["another/fork", "refs/heads/ocv1", false, false, false],
    ["leohenon/opencode-vim", "refs/heads/ocv2", false, false, false],
  ] as const)("reporter gates %s %s dry-run=%s cancelled=%s", (repository, ref, dry_run, cancelled, accepted) => {
    for (const workflow of [sync, publish]) {
      const gate = new Function(
        "github",
        "inputs",
        "needs",
        "always",
        "cancelled",
        `return (${workflow.jobs.issues!.if})`,
      )
      for (const result of ["success", "failure", "skipped", "cancelled"]) {
        expect(
          gate(
            { repository, ref },
            { dry_run },
            { sync: { result }, release: { result } },
            () => true,
            () => cancelled,
          ),
        ).toBe(accepted && (workflow === publish || ["success", "failure"].includes(result)))
      }
    }
  })

  test("reporters cover sync and the entire release dependency chain with independent channel outcomes", () => {
    expect(sync.jobs.issues!.needs).toBe("sync")
    expect(sync.jobs.issues!.env?.OCV_ISSUE_RESULT).toBe("${{ needs.sync.result }}")
    expect(publish.jobs.issues!.needs).toEqual([
      "prepare",
      "compute-nix-hash",
      "update-nix-hashes",
      "prepare-source",
      "release",
    ])
    expect(publish.jobs.issues!.env).toMatchObject({
      OCV_ISSUE_RESULT: "${{ needs.release.result == 'success' && 'success' || 'failure' }}",
      OCV_ISSUE_VERSION: "${{ inputs.version }}",
      OCV_ISSUE_NPM: "${{ needs.release.outputs.npm || 'skipped' }}",
      OCV_ISSUE_GITHUB: "${{ needs.release.outputs.github || 'skipped' }}",
      OCV_ISSUE_HOMEBREW: "${{ needs.release.outputs.homebrew || 'skipped' }}",
    })
    expect(step(publish, "Create GitHub Release").id).toBe("github_release")
    expect(publish.jobs.release!.outputs).toEqual({
      github: "${{ steps.github_release.outcome }}",
      npm: "${{ steps.npm_publish.outcome }}",
      homebrew:
        "${{ (steps.checkout_tap.outcome == 'failure' || steps.update_formula.outcome == 'failure' || steps.push_formula.outcome == 'failure') && 'failure' || steps.push_formula.outcome }}",
    })
    expect(step(publish, "Fail release on publish errors").if).toBe(
      "steps.npm_publish.outcome == 'failure' || steps.checkout_tap.outcome == 'failure' || steps.update_formula.outcome == 'failure' || steps.push_formula.outcome == 'failure'",
    )
  })

  test("release outputs preserve actual channel failures and preparation failures", () => {
    const outcome = (expression: string, values: object) =>
      new Function("steps", `return (${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "")})`)(values)
    const outputs = publish.jobs.release!.outputs!
    const steps = (checkout: string, update: string, push: string) => ({
      checkout_tap: { outcome: checkout },
      update_formula: { outcome: update },
      push_formula: { outcome: push },
    })
    expect(outcome(outputs.homebrew!, steps("failure", "skipped", "skipped"))).toBe("failure")
    expect(outcome(outputs.homebrew!, steps("success", "failure", "skipped"))).toBe("failure")
    expect(outcome(outputs.homebrew!, steps("success", "success", "failure"))).toBe("failure")
    expect(outcome(outputs.homebrew!, steps("success", "success", "success"))).toBe("success")
    expect(outcome(outputs.homebrew!, steps("skipped", "skipped", "skipped"))).toBe("skipped")
    expect(outcome(outputs.github!, { github_release: { outcome: "failure" } })).toBe("failure")
    expect(outcome(outputs.npm!, { npm_publish: { outcome: "success" } })).toBe("success")
    const expression = publish.jobs.issues!.env!.OCV_ISSUE_RESULT!.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    const result = new Function("needs", `return (${expression})`)
    expect(result({ prepare: { result: "failure" }, release: { result: "skipped" } })).toBe("failure")
    expect(result({ "compute-nix-hash": { result: "failure" }, release: { result: "skipped" } })).toBe("failure")
    expect(result({ "prepare-source": { result: "failure" }, release: { result: "skipped" } })).toBe("failure")
    expect(result({ release: { result: "success" } })).toBe("success")
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

async function releaseFixture(directory: string) {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: directory })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  await mkdir(path.join(directory, ".github"))
  await mkdir(path.join(directory, "packages/opencode"), { recursive: true })
  await mkdir(path.join(directory, "shims"))
  await Bun.write(path.join(directory, ".github/ocv-track"), "4.13\n")
  await Bun.write(path.join(directory, "packages/opencode/package.json"), '{"version":"1.18.35"}\n')
  git("init", "-b", "ocv1")
  await Bun.write(
    path.join(directory, ".git/config"),
    (await Bun.file(path.join(directory, ".git/config")).text()) +
      "\n[user]\nname = Fixture\nemail = fixture@example.com\n[commit]\ngpgsign = false\n[core]\nhooksPath = /dev/null\nfsmonitor = false\n",
  )
  git("add", ".")
  git("commit", "-m", "source")
  const source = git("rev-parse", "HEAD")
  await Bun.write(path.join(directory, "README.md"), "Contributors\n")
  git("add", "README.md")
  git("commit", "-m", "contributors")
  const release = git("rev-parse", "HEAD")
  git("commit", "--allow-empty", "-m", "later branch head")
  const head = git("rev-parse", "HEAD")
  git("update-ref", "refs/remotes/origin/ocv1", head)
  await Bun.write(
    path.join(directory, "shims/gh"),
    '#!/bin/sh\nif [ "$1 $2" = "release list" ]; then echo "[]"; exit 0; fi\necho "Unexpected remote operation" >&2\nexit 1\n',
  )
  await chmod(path.join(directory, "shims/gh"), 0o755)
  const run = (name: string, version = "1.18.35-ocv.4.13") =>
    Bun.spawnSync(
      [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        step(publish, name)
          .run!.replaceAll("${{ github.ref_type }}", "branch")
          .replaceAll("${{ github.ref_name }}", "ocv1")
          .replaceAll("${{ inputs.force_nix_hash_refresh }}", "true")
          .replaceAll("${{ steps.notes.outputs.file }}", path.join(directory, "notes")),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          VERSION: version,
          GITHUB_REF: "refs/heads/ocv1",
          GITHUB_REPOSITORY: "leohenon/opencode-vim",
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: path.join(directory, "output"),
          PATH: path.join(directory, "shims") + path.delimiter + process.env.PATH,
        },
      },
    )
  return { git, run, source, release, head }
}

// These execute the real workflow gate; Windows does not provide POSIX bash/jq.
describe.skipIf(process.platform === "win32")("V1 canonical retry source", () => {
  test("successful contributor preparation survives pre-tag release failure and finalizes drafts at that source", async () => {
    await using dir = await tmpdir()
    const fixture = await releaseFixture(dir.path)
    await mkdir(path.join(dir.path, "script"))
    await Bun.write(
      path.join(dir.path, "script/update-contributors.ts"),
      await Bun.file(path.join(root, "script/update-contributors.ts")).text(),
    )
    await Bun.write(path.join(dir.path, "README.md"), "## Thanks to all contributors!\n\nExisting contributors\n\n")
    fixture.git("add", "README.md", "script/update-contributors.ts")
    fixture.git("commit", "-m", "draft source")
    const draftSource = fixture.git("rev-parse", "HEAD")
    fixture.git("update-ref", "refs/remotes/origin/ocv1", draftSource)
    fixture.git("tag", "v1.18.34-ocv.4.13", fixture.source)
    await Bun.write(
      path.join(dir.path, "shims/gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$RUNNER_TEMP/gh-calls"
case "$*" in
  "api "*) echo '[{"number":42,"base":{"ref":"ocv1"},"user":{"login":"external-contributor","type":"User"}}]' ;;
  "release list "*) echo '[{"tagName":"v1.18.35-ocv.4.13","isDraft":true,"isPrerelease":false}]' ;;
  *"--json targetCommitish"*) echo '${draftSource}' ;;
  *"--json isDraft"*) echo true ;;
  "release view "*|"release upload "*|"release edit "*) ;;
  *) echo "Unexpected remote operation" >&2; exit 1 ;;
esac
`,
    )
    const validation = fixture.run("Validate version")
    expect(validation.exitCode, validation.stderr.toString()).toBe(0)
    // Nix preparation advances the initially validated, untagged draft source.
    fixture.git("commit", "--allow-empty", "-m", "Nix hashes")
    const hashSource = fixture.git("rev-parse", "HEAD")
    fixture.git("init", "--bare", path.join(dir.path, "remote.git"))
    fixture.git("remote", "add", "origin", path.join(dir.path, "remote.git"))
    fixture.git("push", "origin", "HEAD:ocv1")
    await Bun.write(path.join(dir.path, "remote.git/hooks/post-receive"), `#!/bin/sh\ncat >> "${dir.path}/pushes"\n`)
    await chmod(path.join(dir.path, "remote.git/hooks/post-receive"), 0o755)
    fixture.git("checkout", "--detach", hashSource)
    expect(fixture.run("Adopt prepared release source").exitCode).toBe(0)
    const preparation = fixture.run("Add release contributors")
    expect(preparation.exitCode, preparation.stderr.toString()).toBe(0)
    expect(fixture.run("Set prepared source SHA").exitCode).toBe(0)
    const preparedSource = (await Bun.file(path.join(dir.path, "output")).text()).trim().replace("sha=", "")
    expect(preparedSource).not.toBe(hashSource)
    expect(fixture.git("rev-parse", `${preparedSource}^`)).toBe(hashSource)
    expect(fixture.git("show", `${preparedSource}:README.md`)).toContain("https://github.com/external-contributor")
    expect(fixture.git("ls-remote", "origin", "refs/heads/ocv1")).toBe(`${preparedSource}\trefs/heads/ocv1`)

    // Run the real release check with a failing Bun shim, before any tag exists.
    await Bun.write(path.join(dir.path, "shims/bun"), "#!/bin/sh\nexit 1\n")
    await chmod(path.join(dir.path, "shims/bun"), 0o755)
    fixture.git("checkout", "--detach", preparedSource)
    expect(fixture.run("Restore existing release source").exitCode).toBe(0)
    expect(fixture.run("Check V1 source").exitCode).not.toBe(0)
    expect(fixture.git("tag", "--list", "v1.18.35-ocv.4.13")).toBe("")
    // A failed-job retry checks out the successful source job's retained output.
    fixture.git("checkout", "--detach", preparedSource)
    expect(fixture.run("Restore existing release source").exitCode).toBe(0)
    expect(fixture.run("Verify immutable release source").exitCode).toBe(0)
    expect(fixture.git("rev-parse", "HEAD")).toBe(preparedSource)
    expect((await Bun.file(path.join(dir.path, "pushes")).text()).trim().split("\n")).toEqual([
      `${hashSource} ${preparedSource} refs/heads/ocv1`,
    ])
    const callsBeforeRelease = await Bun.file(path.join(dir.path, "gh-calls")).text()
    expect(callsBeforeRelease.split("\n").filter((line) => line.startsWith("api "))).toHaveLength(
      Number(fixture.git("rev-list", "--count", `v1.18.34-ocv.4.13..${hashSource}`)),
    )
    await mkdir(path.join(dir.path, "packages/opencode/dist/release"), { recursive: true })
    await Bun.write(path.join(dir.path, "packages/opencode/dist/release/ocv-fixture"), "binary")
    await Bun.write(path.join(dir.path, "notes"), "release notes")
    const publication = fixture.run("Create GitHub Release")
    expect(publication.exitCode, publication.stderr.toString()).toBe(0)
    const edit = (await Bun.file(path.join(dir.path, "gh-calls")).text())
      .split("\n")
      .find((line) => line.startsWith("release edit "))!
    expect(edit).toContain(`--target ${preparedSource} `)
    expect(edit).not.toContain(draftSource)
  })

  test("published release retries download canonical assets without edits or uploads", async () => {
    await using dir = await tmpdir()
    const fixture = await releaseFixture(dir.path)
    await Bun.write(
      path.join(dir.path, "shims/gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$RUNNER_TEMP/gh-calls"
case "$*" in
  *"--json isDraft"*) echo false ;;
  "release view "*|"release download "*) ;;
  *) exit 1 ;;
esac
`,
    )
    expect(fixture.run("Create GitHub Release").exitCode).toBe(0)
    const calls = await Bun.file(path.join(dir.path, "gh-calls")).text()
    expect(calls).toContain("release download ")
    expect(calls).not.toMatch(/release (upload|edit|create) /)
  })

  test.each(["Adopt existing release source", "Adopt prepared release source", "Restore existing release source"])(
    "%s pins only existing releases",
    async (name) => {
      await using dir = await tmpdir()
      const fixture = await releaseFixture(dir.path)
      fixture.git("checkout", "--detach", fixture.source)
      expect(fixture.run(name).exitCode).toBe(0)
      expect(fixture.git("rev-parse", "HEAD")).toBe(fixture.source)
      fixture.git("tag", "v1.18.35-ocv.4.13", fixture.release)
      for (const checkout of [fixture.source, fixture.head]) {
        fixture.git("checkout", "--detach", checkout)
        // A failed release-only job retry starts at the old prepared parent.
        expect(fixture.run("Verify immutable release source").exitCode).not.toBe(0)
        expect(fixture.run(name).exitCode).toBe(0)
        expect(fixture.git("rev-parse", "HEAD")).toBe(fixture.release)
        expect(fixture.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD")
        expect(fixture.run("Validate version").exitCode).toBe(0)
        expect(fixture.run("Verify immutable release source").exitCode).toBe(0)
      }
    },
  )

  test.each(["Adopt existing release source", "Adopt prepared release source", "Restore existing release source"])(
    "%s rejects unrelated tags and unsafe versions",
    async (name) => {
      await using dir = await tmpdir()
      const fixture = await releaseFixture(dir.path)
      fixture.git("checkout", "--orphan", "unrelated")
      fixture.git("commit", "--allow-empty", "-m", "unrelated source")
      fixture.git("tag", "v1.18.35-ocv.4.13")
      fixture.git("checkout", "--detach", fixture.source)
      expect(fixture.run(name).exitCode).not.toBe(0)
      expect(fixture.git("rev-parse", "HEAD")).toBe(fixture.source)
      for (const version of ["2.1.2-ocv.4.13", "1.18.35-ocv.4.13^{commit}", "--help"]) {
        expect(fixture.run(name, version).exitCode).not.toBe(0)
        expect(fixture.git("rev-parse", "HEAD")).toBe(fixture.source)
      }
    },
  )

  test.each(["track", "base"])("validates the canonical tag's %s rather than the requested checkout", async (field) => {
    await using dir = await tmpdir()
    const fixture = await releaseFixture(dir.path)
    fixture.git("checkout", "--detach", fixture.release)
    await Bun.write(
      path.join(dir.path, field === "track" ? ".github/ocv-track" : "packages/opencode/package.json"),
      field === "track" ? "4.14\n" : '{"version":"1.18.34"}\n',
    )
    fixture.git("commit", "-am", "incompatible release metadata")
    fixture.git("tag", "v1.18.35-ocv.4.13")
    fixture.git("update-ref", "refs/remotes/origin/ocv1", "HEAD")
    fixture.git("checkout", "--detach", fixture.source)
    expect(fixture.run("Validate version").exitCode).not.toBe(0) // Raw gate still rejects a different tagged source.
    expect(fixture.run("Adopt existing release source").exitCode).toBe(0)
    const validation = fixture.run("Validate version")
    expect(validation.exitCode).not.toBe(0)
    expect(validation.stdout.toString() + validation.stderr.toString()).toContain(
      field === "track" ? "does not match pinned track" : "Version must match the V1 source and track",
    )
  })

  test("forced hash refresh cannot mutate a pinned release", async () => {
    await using dir = await tmpdir()
    const fixture = await releaseFixture(dir.path)
    fixture.git("checkout", "--detach", fixture.source)
    expect(fixture.run("Detect Nix hash state").exitCode).toBe(0)
    expect(await Bun.file(path.join(dir.path, "output")).text()).toContain("current=false")
    fixture.git("tag", "v1.18.35-ocv.4.13", fixture.release)
    expect(fixture.run("Adopt existing release source").exitCode).toBe(0)
    await Bun.write(path.join(dir.path, "output"), "")
    expect(fixture.run("Detect Nix hash state").exitCode).toBe(0)
    expect(await Bun.file(path.join(dir.path, "output")).text()).toBe(
      `sha=${fixture.release}\nbranch=ocv1\ncurrent=true\n`,
    )
    expect(fixture.git("rev-parse", "HEAD")).toBe(fixture.release)
    expect(fixture.git("status", "--short", "--untracked-files=no")).toBe("")
    expect(publish.jobs["compute-nix-hash"]!.if).toContain("needs.prepare.outputs.nix_hashes_current != 'true'")
    for (const item of publish.jobs["update-nix-hashes"]!.steps!.filter((item) =>
      /git push|update-node-modules/.test(item.run ?? ""),
    ))
      expect(item.if).toContain("needs.prepare.outputs.nix_hashes_current != 'true'")
  })
})

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

describe.skipIf(process.platform === "win32")("V1 Homebrew monotonicity", () => {
  test("an old failed-job retry cannot overwrite a newer stable formula", async () => {
    await using dir = await tmpdir()
    await mkdir(path.join(dir.path, "tap/Formula"), { recursive: true })
    const current = 'class Ocv < Formula\n  version "1.19.5-ocv.4.14"\nend\n'
    await Bun.write(path.join(dir.path, "tap/Formula/ocv.rb"), current)
    const script = step(publish, "Update formula").run!.replace(/\$\{\{ steps\.sum\.outputs\.\w+ \}\}/g, "a".repeat(64))
    const result = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", script], {
      cwd: dir.path,
      env: { ...process.env, VERSION: "1.19.4-ocv.4.14" },
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Refusing Homebrew downgrade")
    expect(await Bun.file(path.join(dir.path, "tap/Formula/ocv.rb")).text()).toBe(current)
  })
})
