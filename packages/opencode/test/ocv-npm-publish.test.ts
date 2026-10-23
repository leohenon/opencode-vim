import { describe, expect, test } from "bun:test"
import { chmod, mkdir } from "fs/promises"
import path from "path"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const publisher = path.resolve(import.meta.dir, "../script/publish-ocv-npm.ts")
const version = "1.18.35-ocv.4.13"
const name = "@leohenon/ocv"
const view = ["view", `${name}@${version}`, "version", "--json"]
const latest = ["view", `${name}@latest`, "version", "--json"]
const absent = { code: 1, stdout: JSON.stringify({ error: { code: "E404" } }) }

type Step = { args: string[]; code?: number; stdout?: string; stderr?: string }

// These subprocesses use an executable PATH shim, not the Windows npm.cmd launcher.
describe.skipIf(process.platform === "win32")("V1 npm publisher retries", () => {
  test("explicit dry runs override both CI and local publish authorization", async () => {
    for (const env of [{ OCV_DRY_RUN: "true" }, {}]) {
      const result = await run([], env, env.OCV_DRY_RUN ? [] : ["--dry-run"])
      expect(result.stderr).toBe("")
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("dry run")
      expect(result.calls).toEqual([])
    }
  })

  test("rejects V2, invalid versions and non-latest tags before npm calls", async () => {
    for (const env of [
      { OPENCODE_VERSION: "2.0.0-ocv.4.13" },
      { OPENCODE_VERSION: "1.18.35" },
      { OPENCODE_VERSION: "invalid" },
      { OCV_NPM_TAG: "ocv-v2" },
    ]) {
      const result = await run([], env)
      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/must be an OCV V1 version|only to the latest/)
      expect(result.calls).toEqual([])
    }
  })

  test("E404 permits publishing the packed fixture", async () => {
    const result = await run([{ args: view, ...absent }, { args: latest, ...absent }, { args: ["publish"] }])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.calls.map((args) => args[0])).toEqual(["view", "view", "publish"])
    expect(result.calls[2]?.slice(-4)).toEqual(["--access", "public", "--tag", "latest"])
  })

  test("absent newer version publishes after checking current V1 latest", async () => {
    const result = await run([
      { args: view, ...absent },
      { args: latest, stdout: JSON.stringify("1.18.35-ocv.4.9") },
      { args: ["publish"] },
    ])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.calls.map((args) => args[0])).toEqual(["view", "view", "publish"])
  })

  test("absent older version cannot downgrade newer V1 latest", async () => {
    const result = await run([
      { args: view, ...absent },
      { args: latest, stdout: JSON.stringify("1.18.35-ocv.4.14") },
    ])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Refusing to publish")
    expect(result.calls).toEqual([view, latest])
  })

  test("absent version does not publish when latest metadata is invalid", async () => {
    for (const response of ["2.0.0-ocv.4.13", "invalid", { version }]) {
      const result = await run([
        { args: view, ...absent },
        { args: latest, stdout: JSON.stringify(response) },
      ])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("Invalid V1 registry version")
      expect(result.calls).toEqual([view, latest])
    }
  })

  test("absent version does not publish when latest lookup fails", async () => {
    for (const code of ["ENETUNREACH", "E401", "E403"]) {
      const result = await run([
        { args: view, ...absent },
        { args: latest, code: 1, stdout: JSON.stringify({ error: { code } }) },
      ])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("failed to look up")
      expect(result.calls).toEqual([view, latest])
    }
  })

  test("network and auth errors abort without publishing", async () => {
    for (const code of ["ENETUNREACH", "E401", "E403"]) {
      const result = await run([{ args: view, code: 1, stdout: JSON.stringify({ error: { code } }) }])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("failed to look up")
      expect(result.calls).toEqual([view])
    }
  })

  test("successful metadata must match the requested V1 version", async () => {
    for (const response of ["1.18.34-ocv.4.13", "2.0.0-ocv.4.13", { version }, [version]]) {
      const result = await run([{ args: view, stdout: JSON.stringify(response) }])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("Invalid V1 registry version")
      expect(result.calls).toEqual([view])
    }
  })

  test("existing version repairs an older latest tag", async () => {
    const result = await run([
      { args: view, stdout: JSON.stringify(version) },
      { args: latest, stdout: JSON.stringify("1.18.35-ocv.4.12") },
      { args: ["dist-tag", "add", `${name}@${version}`, "latest"] },
    ])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.calls.map((args) => args[0])).toEqual(["view", "view", "dist-tag"])
  })

  test("existing newer stable tag is never downgraded", async () => {
    const result = await run([
      { args: view, stdout: JSON.stringify(version) },
      { args: latest, stdout: JSON.stringify("1.18.35-ocv.4.14") },
    ])
    expect(result.stderr).toBe("")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("keep latest")
    expect(result.calls).toEqual([view, latest])
  })

  test("matching latest is a no-op and missing latest can be restored", async () => {
    for (const missing of [false, true]) {
      const result = await run([
        { args: view, stdout: JSON.stringify(version) },
        { args: latest, ...(missing ? absent : { stdout: JSON.stringify(version) }) },
        ...(missing ? [{ args: ["dist-tag", "add", `${name}@${version}`, "latest"] }] : []),
      ])
      expect(result.code).toBe(0)
      expect(result.calls.length).toBe(missing ? 3 : 2)
    }
  })

  test("refuses non-V1 latest metadata without changing tags", async () => {
    const result = await run([
      { args: view, stdout: JSON.stringify(version) },
      { args: latest, stdout: JSON.stringify("2.0.0-ocv.4.13") },
    ])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Invalid V1 registry version")
    expect(result.calls).toEqual([view, latest])
  })

  test("conflict verifies the immutable version before repairing latest", async () => {
    const result = await run([
      { args: view, ...absent },
      { args: latest, stdout: JSON.stringify("1.18.35-ocv.4.12") },
      { args: ["publish"], code: 1, stderr: "EPUBLISHCONFLICT" },
      { args: view, stdout: JSON.stringify(version) },
      { args: latest, stdout: JSON.stringify("1.18.35-ocv.4.12") },
      { args: ["dist-tag", "add", `${name}@${version}`, "latest"] },
    ])
    expect(result.code).toBe(0)
    expect(result.calls.map((args) => args[0])).toEqual(["view", "view", "publish", "view", "view", "dist-tag"])
  })

  test("conflict is not success when verification is absent or unavailable", async () => {
    for (const verification of [absent, { code: 1, stdout: JSON.stringify({ error: { code: "E401" } }) }]) {
      const result = await run([
        { args: view, ...absent },
        { args: latest, stdout: JSON.stringify("1.18.35-ocv.4.12") },
        { args: ["publish"], code: 1, stderr: "EPUBLISHCONFLICT" },
        { args: view, ...verification },
      ])
      expect(result.code).not.toBe(0)
      expect(result.calls.map((args) => args[0])).toEqual(["view", "view", "publish", "view"])
    }
  })
})

async function run(steps: Step[], env: Record<string, string | undefined> = {}, args: string[] = []) {
  await using dir = await tmpdir()
  await mkdir(path.join(dir.path, "bin"))
  await mkdir(path.join(dir.path, "home"))
  const log = path.join(dir.path, "calls.json")
  await Bun.write(log, "[]")
  await Bun.write(path.join(dir.path, "steps.json"), JSON.stringify(steps))
  const shim = path.join(dir.path, "bin", "npm")
  await Bun.write(
    shim,
    `#!${process.execPath}
const fs = require("fs")
const args = process.argv.slice(2)
const calls = JSON.parse(fs.readFileSync(process.env.NPM_FIXTURE_LOG, "utf8"))
const steps = JSON.parse(fs.readFileSync(process.env.NPM_FIXTURE_STEPS, "utf8"))
const step = steps[calls.length]
calls.push(args)
fs.writeFileSync(process.env.NPM_FIXTURE_LOG, JSON.stringify(calls))
if (!step || step.args.some((arg, i) => args[i] !== arg)) {
  console.error("Unexpected npm invocation: " + JSON.stringify(args))
  process.exit(99)
}
process.stdout.write(step.stdout || "")
process.stderr.write(step.stderr || "")
process.exit(step.code || 0)
`,
  )
  await chmod(shim, 0o755)
  const result = Bun.spawnSync([process.execPath, publisher, ...args], {
    env: {
      ...process.env,
      HOME: path.join(dir.path, "home"),
      XDG_CONFIG_HOME: path.join(dir.path, "home", "config"),
      PATH: path.join(dir.path, "bin") + path.delimiter + process.env.PATH,
      CI: "true",
      OCV_ALLOW_LOCAL_PUBLISH: "1",
      OCV_DRY_RUN: "false",
      OCV_NPM_TAG: "latest",
      OPENCODE_VERSION: version,
      NPM_FIXTURE_LOG: log,
      NPM_FIXTURE_STEPS: path.join(dir.path, "steps.json"),
      ...env,
    },
  })
  const calls: string[][] = await Bun.file(log).json()
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), calls }
}
