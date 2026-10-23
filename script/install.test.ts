import { afterAll, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"

const script = path.resolve(import.meta.dir, "../install")
const root = await mkdtemp(path.join(os.tmpdir(), "opencode-install-test-"))
afterAll(() => rm(root, { recursive: true, force: true }))

// Stands in for curl: answers the npm registry, the GitHub release list, and release downloads.
// HEAD requests for a release asset report ASSET_STATUS (200 by default).
const curl = `#!/usr/bin/env bash
echo "$*" >> "$CURL_LOG"
out=""
url=""
head=false
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|--max-time) shift 2 ;;
    -I|-sI|-sIL) head=true; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://registry.npmjs.org/opencode-ai/latest) [ -n "$NPM_BODY" ] || exit 22; printf '%s' "$NPM_BODY" ;;
  https://api.github.com/repos/anomalyco/opencode/releases*) printf '%s' "$GITHUB_BODY" ;;
  https://github.com/anomalyco/opencode/releases/download/*)
    if [ "$head" = true ]; then printf '%s' "\${ASSET_STATUS:-200}"; else cp "$ARCHIVE" "$out"; fi ;;
  *) exit 22 ;;
esac
`

const bin = path.join(root, "bin")
await Bun.write(path.join(bin, "curl"), curl)
await $`chmod +x ${path.join(bin, "curl")}`
const archive = path.join(root, "opencode.tar.gz")
await Bun.write(path.join(root, "payload", "opencode"), "#!/bin/sh\necho installed\n")
await $`tar -czf ${archive} -C ${path.join(root, "payload")} opencode`

let run = 0
async function install(input: { env?: Record<string, string>; args?: string[] }) {
  const home = path.join(root, `home-${run++}`)
  const log = path.join(home, "curl.log")
  await Bun.write(log, "")
  const proc = Bun.spawn(["bash", script, "--no-modify-path", ...(input.args ?? [])], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      SHELL: "/bin/bash",
      TMPDIR: home,
      CURL_LOG: log,
      ARCHIVE: archive,
      ...input.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    code,
    output: stdout + stderr,
    curl: (await Bun.file(log).text()).trim().split("\n").filter(Boolean),
    installed: await Bun.file(path.join(home, ".opencode", "bin", "opencode")).exists(),
  }
}

describe("install script", () => {
  test("refuses an OpenCode 2 VERSION before downloading anything", async () => {
    for (const version of ["2.0.0", "v2.0.27", "10.1.0"]) {
      const result = await install({ env: { VERSION: version } })
      expect(result.code).toBe(1)
      expect(result.output).toContain("https://opencode.ai/v2/install")
      expect(result.curl).toEqual([])
      expect(result.installed).toBe(false)
    }
  })

  test("refuses an OpenCode 2 --version", async () => {
    const result = await install({ args: ["--version", "2.0.0"] })
    expect(result.code).toBe(1)
    expect(result.output).toContain("opencode upgrade --major")
  })

  test.skipIf(process.platform !== "linux")("installs an explicit OpenCode 1 version", async () => {
    const result = await install({ env: { VERSION: "1.18.35" } })
    expect(result.code).toBe(0)
    expect(result.installed).toBe(true)
    expect(result.curl.at(-1)).toContain("releases/download/v1.18.35/")
  })

  test.skipIf(process.platform !== "linux")("reads the version from npm", async () => {
    const result = await install({
      env: { NPM_BODY: '{"name":"opencode-ai","_npmVersion":"11.0.0","version":"1.19.2"}' },
    })
    expect(result.code).toBe(0)
    expect(result.output).toContain("version: \x1b[0m1.19.2")
    expect(result.curl.some((line) => line.includes("api.github.com"))).toBe(false)
    expect(result.curl.at(-1)).toContain("releases/download/v1.19.2/")
  })

  test.skipIf(process.platform !== "linux")("falls back to the newest v1 GitHub release when npm fails", async () => {
    const result = await install({
      env: { GITHUB_BODY: '[{"tag_name": "v2.0.28"},{"tag_name": "v1.19.0"},{"tag_name": "v1.18.35"}]' },
    })
    expect(result.code).toBe(0)
    expect(result.curl.some((line) => line.includes("releases/latest"))).toBe(false)
    expect(result.curl.at(-1)).toContain("releases/download/v1.19.0/")
  })

  test.skipIf(process.platform !== "linux")(
    "falls back to GitHub while the npm version's release is still publishing",
    async () => {
      const result = await install({
        env: { NPM_BODY: '{"version":"1.19.2"}', ASSET_STATUS: "404", GITHUB_BODY: '[{"tag_name": "v1.19.1"}]' },
      })
      expect(result.code).toBe(0)
      expect(result.curl.at(-1)).toContain("releases/download/v1.19.1/")
    },
  )

  test.skipIf(process.platform !== "linux")("ignores an OpenCode 2 version from npm", async () => {
    const result = await install({
      env: { NPM_BODY: '{"version":"2.0.27"}', GITHUB_BODY: '[{"tag_name": "v1.19.0"}]' },
    })
    expect(result.code).toBe(0)
    expect(result.curl.at(-1)).toContain("releases/download/v1.19.0/")
  })

  test("reports a missing explicit release", async () => {
    const result = await install({ env: { VERSION: "1.19.9", ASSET_STATUS: "404" } })
    expect(result.code).toBe(1)
    expect(result.output).toContain("Release v1.19.9 not found")
    expect(result.installed).toBe(false)
  })
})
