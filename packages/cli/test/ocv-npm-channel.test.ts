import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

const candidate = "2.1.4-ocv.4.10"
const older = "2.1.4-ocv.4.9"
const newer = "2.1.4-ocv.4.11"
const name = "@leohenon/ocv"
const native = "@leohenon/ocv-cli-linux-x64"
const publisher = path.resolve(import.meta.dir, "../script/publish.ts")

type Scenario = {
  channel?: string
  after?: string | null
  error?: string
  lookupVersion?: string
  versionError?: string
  existing?: boolean
  version?: string
  binaryVersion?: string
  dryRun?: boolean
  prepack?: boolean
}

async function run(input: Scenario = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocv-npm-channel-"))
  try {
    const bin = path.join(root, "bin")
    const dist = path.join(root, "dist")
    const log = path.join(root, "calls.jsonl")
    await Bun.write(path.join(root, "state.json"), JSON.stringify(input))
    await Bun.write(
      path.join(dist, "cli-linux-x64/package.json"),
      JSON.stringify({
        name: native,
        version: input.binaryVersion ?? input.version ?? candidate,
      }),
    )
    await Bun.write(path.join(dist, "cli-linux-x64/bin/ocv"), "fixture binary")
    await Bun.write(
      path.join(bin, "npm"),
      `#!${process.execPath}
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(process.env.NPM_TEST_LOG, JSON.stringify(args) + "\\n")
const file = Bun.file(process.env.NPM_TEST_STATE)
const state = await file.json()
function missing(code = "E404") {
  console.log(JSON.stringify({ error: { code, summary: "fixture lookup failure" } }))
  process.exit(1)
}
if (args[0] === "view") {
  if (args[1] === "@leohenon/ocv@ocv-v2") {
    if (state.error) missing(state.error)
    const channel = state.looked ? (state.after === undefined ? state.channel : state.after) : state.channel
    state.looked = true
    await file.write(JSON.stringify(state))
    if (!channel) missing()
    console.log(JSON.stringify(channel))
    process.exit(0)
  }
  if (state.versionError) missing(state.versionError)
  if (!state.existing) missing()
  console.log(JSON.stringify(state.lookupVersion ?? state.version ?? "${candidate}"))
  process.exit(0)
}
if (args[0] === "publish") {
  if (args.slice(-2).join(" ") !== "--tag ocv-v2") process.exit(2)
  const pkg = await Bun.file("package.json").json()
  if (pkg.name === "@leohenon/ocv") {
    state.channel = pkg.version
    await file.write(JSON.stringify(state))
  }
  process.exit(0)
}
if (args.join(" ") === "dist-tag add @leohenon/ocv@${candidate} ocv-v2") process.exit(0)
process.exit(3)
`,
    )
    await chmod(path.join(bin, "npm"), 0o755)
    await symlink(process.execPath, path.join(bin, "bun"))
    await Bun.write(
      path.join(root, ".npmrc"),
      "registry=http://127.0.0.1:1\noffline=true\n//registry.npmjs.org/:_authToken=fake-test-token\n",
    )
    const launch = (dryRun: boolean) =>
      Bun.spawn([process.execPath, publisher, ...(dryRun ? ["--dry-run"] : [])], {
        cwd: root,
        env: isolatedEnv(root, {
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          OPENCODE_CLI_DIST: dist,
          OPENCODE_CHANNEL: "ocv-v2",
          OPENCODE_VERSION: input.version ?? candidate,
          NPM_TOKEN: "fake-test-token",
          NODE_AUTH_TOKEN: "fake-test-token",
          NPM_CONFIG_USERCONFIG: path.join(root, ".npmrc"),
          NPM_CONFIG_REGISTRY: "http://127.0.0.1:1",
          NPM_CONFIG_OFFLINE: "true",
          NPM_TEST_LOG: log,
          NPM_TEST_STATE: path.join(root, "state.json"),
        }),
        stdout: "pipe",
        stderr: "pipe",
      })
    if (input.prepack) {
      const packed = launch(true)
      const [code, stdout, stderr] = await Promise.all([
        packed.exited,
        new Response(packed.stdout).text(),
        new Response(packed.stderr).text(),
      ])
      expect(code, stdout + stderr).toBe(0)
    }
    const child = launch(input.dryRun ?? false)
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const calls: string[][] = (await Bun.file(log).exists())
      ? (await Bun.file(log).text())
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : []
    const tarballs = Array.from(new Bun.Glob("**/*.tgz").scanSync({ cwd: dist }))
    const contents: string[] = []
    if (input.prepack) {
      for (const tarball of tarballs) {
        const archive = Bun.spawn(["tar", "-tzf", path.join(dist, tarball)], { stdout: "pipe", stderr: "pipe" })
        const [code, stdout, stderr] = await Promise.all([
          archive.exited,
          new Response(archive.stdout).text(),
          new Response(archive.stderr).text(),
        ])
        expect(code, stderr).toBe(0)
        contents.push(...stdout.trim().split("\n"))
      }
    }
    return {
      code,
      output: stdout + stderr,
      calls,
      writes: calls.filter((args) => args[0] !== "view"),
      tarballs,
      contents,
      manifest: (await Bun.file(path.join(dist, name, "package.json")).exists())
        ? await Bun.file(path.join(dist, name, "package.json")).json()
        : undefined,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("older candidate is refused before any native or root publication", async () => {
  const result = await run({ channel: newer })
  expect(result.output).toContain("Refusing to downgrade")
  expect(result.code).not.toBe(0)
  expect(result.calls).toEqual([["view", `${name}@ocv-v2`, "version", "--json"]])
  expect(result.tarballs).toEqual([])
})

test.each(["E401", "E403", "ECONNRESET", "E500"])("channel lookup %s aborts before publication", async (error) => {
  const result = await run({ error })
  expect(result.output).toContain(error)
  expect(result.code).not.toBe(0)
  expect(result.writes).toEqual([])
})

test.each([{}, { channel: older }])(
  "first release E404 and newer candidates publish only with ocv-v2",
  async (input) => {
    const result = await run(input)
    expect(result.output).toContain("opencode script")
    expect(result.output).not.toContain("error:")
    expect(result.code).toBe(0)
    expect(result.writes).toHaveLength(2)
    expect(result.writes.every((args) => args[0] === "publish" && args.slice(-2).join(" ") === "--tag ocv-v2")).toBe(
      true,
    )
    expect(result.manifest.version).toBe(candidate)
    expect(result.manifest.optionalDependencies).toEqual({ [native]: candidate })
    expect(result.tarballs).toHaveLength(2)
  },
)

test("immutable-version auth failures halt rather than attempting publish", async () => {
  const result = await run({ channel: older, versionError: "E401" })
  expect(result.output).toContain("E401")
  expect(result.code).not.toBe(0)
  expect(result.writes).toEqual([])
})

test.each([undefined, older, candidate, newer])(
  "existing retry reconciles fresh channel %s without downgrading",
  async (after) => {
    const result = await run({ channel: older, existing: true, after: after ?? null })
    expect(result.output).toContain(`already published ${name}@${candidate}`)
    expect(result.code).toBe(0)
    expect(result.tarballs).toHaveLength(2)
    expect(result.calls.filter((args) => args[1] === `${name}@ocv-v2`)).toHaveLength(2)
    expect(result.writes).toEqual(
      !after || after === older ? [["dist-tag", "add", `${name}@${candidate}`, "ocv-v2"]] : [],
    )
  },
)

test.each(["2.1.4", "1.1.4-ocv.4.10", "2.1.4-ocv.04.10", "garbage"])(
  "rejects invalid V2 candidate %s before registry calls",
  async (version) => {
    const result = await run({ version })
    expect(result.output).toContain("Invalid OCV V2 version")
    expect(result.code).not.toBe(0)
    expect(result.calls).toEqual([])
  },
)

test("invalid channel metadata aborts publication", async () => {
  const result = await run({ channel: "2.1.4" })
  expect(result.output).toContain("Invalid OCV V2 version")
  expect(result.code).not.toBe(0)
  expect(result.writes).toEqual([])
})

test("binary version must still match Script.version", async () => {
  const result = await run({ binaryVersion: older })
  expect(result.output).toContain(`Expected ${candidate}, got ${older}`)
  expect(result.code).not.toBe(0)
  expect(result.calls).toEqual([])
})

test("dry-run overrides every registry action while retaining matching tarballs", async () => {
  const result = await run({ dryRun: true, channel: newer, error: "E401" })
  expect(result.output).toContain("opencode script")
  expect(result.code).toBe(0)
  expect(result.calls).toEqual([])
  expect(result.tarballs).toHaveLength(2)
  expect(result.manifest.version).toBe(candidate)
})

test("immutable package lookup must resolve the exact requested version", async () => {
  const result = await run({ channel: candidate, existing: true, lookupVersion: newer })
  expect(result.code).not.toBe(0)
  expect(result.output).toContain("Expected")
  expect(result.writes).toEqual([])
})

test("publication after dry-run packing never nests old tarballs in either distribution", async () => {
  const result = await run({ prepack: true })
  expect(result.code, result.output).toBe(0)
  expect(result.tarballs).toHaveLength(2)
  expect(result.writes).toHaveLength(2)
  expect(result.contents).toContain("package/bin/ocv")
  expect(result.contents).toContain("package/bin/ocv.cjs")
  expect(result.contents.filter((entry) => entry.endsWith("package.json"))).toHaveLength(2)
  expect(result.contents.some((entry) => entry.endsWith(".tgz"))).toBe(false)
})
