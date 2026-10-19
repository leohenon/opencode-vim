#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const file = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(file), "..")
process.chdir(root)

const version = process.env.OPENCODE_VERSION
if (!version) {
  throw new Error("OPENCODE_VERSION is required")
}

const tag = process.env.OCV_NPM_TAG || "latest"
const tries = 6
const canPublish = process.env.CI === "true" || process.env.OCV_ALLOW_LOCAL_PUBLISH === "1"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function exists(name: string, version: string) {
  const result = await $`npm view ${`${name}@${version}`} version --json`.nothrow()
  return result.exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  if (!canPublish) {
    console.log(`dry run (set OCV_ALLOW_LOCAL_PUBLISH=1 to publish): ${name}@${version}`)
    return
  }

  if (await exists(name, version)) {
    console.log(`skip ${name}@${version} (already published)`)
    return
  }

  for (let i = 0; i < tries; i++) {
    const result = await $`npm publish *.tgz --access public --tag ${tag}`.cwd(dir).nothrow()
    if (result.exitCode === 0) {
      console.log(`published ${name}@${version}`)
      return
    }

    const err = result.stderr.toString() + "\n" + result.stdout.toString()
    if (err.includes("cannot publish over the previously published versions") || err.includes("EPUBLISHCONFLICT")) {
      console.log(`skip ${name}@${version} (already published)`)
      return
    }

    const limited = err.includes("E429") || err.includes("429 Too Many Requests") || err.includes("rate limited")
    if (!limited || i === tries - 1) {
      throw new Error(`failed to publish ${name}@${version}: ${err}`)
    }

    const ms = 5000 * 2 ** i
    console.log(`rate limited publishing ${name}@${version}, retrying in ${ms}ms`)
    await wait(ms)
  }
}

const out = path.join(root, "dist", "npm", "ocv")
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, "bin"), { recursive: true })

const pkg = {
  name: "@leohenon/ocv",
  version,
  license: "MIT",
  repository: {
    type: "git",
    url: "https://github.com/leohenon/opencode-vim",
  },
  homepage: "https://leohenon.github.io/opencode-vim/",
  bugs: {
    url: "https://github.com/leohenon/opencode-vim/issues",
  },
  bin: {
    ocv: "./bin/ocv",
  },
  scripts: {
    postinstall: "node ./postinstall.cjs",
  },
  engines: {
    node: ">=18",
  },
}

const launcher = `#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const path = require("path")

function run(target) {
  const result = childProcess.spawnSync(target, process.argv.slice(2), {
    stdio: "inherit",
  })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  const code = typeof result.status === "number" ? result.status : 0
  process.exit(code)
}

const envPath = process.env.OCV_BIN_PATH
if (envPath) run(envPath)

const ext = process.platform === "win32" ? ".exe" : ""
const bin = path.join(__dirname, ".ocv" + ext)
if (!fs.existsSync(bin)) {
  console.error("ocv binary is missing. Try reinstalling: npm i -g @leohenon/ocv@latest")
  process.exit(1)
}

run(bin)
`

const postinstall = `#!/usr/bin/env node

const fs = require("fs")
const os = require("os")
const path = require("path")

const version = process.env.npm_package_version
const baseUrl = process.env.OCV_RELEASE_BASE_URL || "https://github.com/leohenon/opencode-vim/releases/download"
const node = Number((process.versions.node || "0").split(".")[0])

function text(err) {
  return err instanceof Error ? err.message : String(err)
}

function platform() {
  const map = { darwin: "darwin", linux: "linux", win32: "windows" }
  return map[os.platform()] || os.platform()
}

function arch() {
  const map = { x64: "x64", arm64: "arm64", arm: "arm" }
  return map[os.arch()] || os.arch()
}

function avx2(p, a) {
  if (a !== "x64") return false

  if (p === "linux") {
    try {
      return /(^|\\s)avx2(\\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (p === "darwin") {
    try {
      const childProcess = require("child_process")
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }

  return false
}

function musl() {
  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {}

  try {
    const childProcess = require("child_process")
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    const text = ((result.stdout || "") + (result.stderr || "")).toLowerCase()
    if (text.includes("musl")) return true
  } catch {}

  return false
}

function names(p, a) {
  const base = "ocv-" + p + "-" + a
  const baseline = a === "x64" && !avx2(p, a)

  if (p === "linux") {
    if (musl()) {
      if (a === "x64") {
        if (baseline) return [base + "-baseline-musl", base + "-musl", base + "-baseline", base]
        return [base + "-musl", base + "-baseline-musl", base, base + "-baseline"]
      }
      return [base + "-musl", base]
    }

    if (a === "x64") {
      if (baseline) return [base + "-baseline", base, base + "-baseline-musl", base + "-musl"]
      return [base, base + "-baseline", base + "-musl", base + "-baseline-musl"]
    }
    return [base, base + "-musl"]
  }

  if (a === "x64") {
    if (baseline) return [base + "-baseline", base]
    return [base, base + "-baseline"]
  }

  return [base]
}

async function main() {
  if (node < 18) {
    throw new Error("@leohenon/ocv install requires Node 18+ (detected " + process.versions.node + ")")
  }

  const p = platform()
  const a = arch()
  const ext = p === "windows" ? ".exe" : ""
  const out = path.join(__dirname, "bin", ".ocv" + ext)
  const list = names(p, a)

  fs.mkdirSync(path.dirname(out), { recursive: true })

  for (const name of list) {
    const url = baseUrl + "/v" + version + "/" + name + ext
    let result
    try {
      result = await fetch(url)
    } catch (err) {
      throw new Error("Failed to download " + name + ext + " from " + url + ": " + text(err))
    }
    if (result.status === 404) continue
    if (!result.ok) {
      throw new Error("Failed to download " + name + ext + " from " + url + ": " + result.status + " " + result.statusText)
    }
    const data = Buffer.from(await result.arrayBuffer())
    fs.writeFileSync(out, data)
    fs.chmodSync(out, 0o755)
    console.log("installed ocv binary: " + name + ext)
    return
  }

  throw new Error("No compatible release asset found for " + p + "/" + a + " (" + list.join(", ") + ")")
}

main().catch((err) => {
  console.error("Failed to install ocv binary:", err.message)
  process.exit(1)
})
`

fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n")
fs.writeFileSync(path.join(out, "README.md"), "# @leohenon/ocv\n\nocv (OpenCode fork with vim keybindings).\n")
fs.writeFileSync(path.join(out, "postinstall.cjs"), postinstall)
fs.writeFileSync(path.join(out, "bin", "ocv"), launcher)
fs.chmodSync(path.join(out, "bin", "ocv"), 0o755)
fs.copyFileSync(path.join(root, "..", "..", "LICENSE"), path.join(out, "LICENSE"))

await $`bun pm pack`.cwd(out)
await publish(out, "@leohenon/ocv", version)
