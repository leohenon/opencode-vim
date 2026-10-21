#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const path = require("path")
const os = require("os")

const forwardedSignals =
  process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR1"]

function run(target, cleanup) {
  const child = childProcess.spawn(target, process.argv.slice(2), { stdio: "inherit" })
  child.on("error", (error) => {
    cleanup?.()
    console.error(error.message)
    process.exit(1)
  })
  const forwarders = {}
  for (const signal of forwardedSignals) {
    forwarders[signal] = () => {
      try {
        child.kill(signal)
      } catch {}
    }
    process.on(signal, forwarders[signal])
  }
  child.on("exit", (code, signal) => {
    for (const forwardedSignal of forwardedSignals) process.removeListener(forwardedSignal, forwarders[forwardedSignal])
    cleanup?.()
    if (signal) return process.kill(process.pid, signal)
    process.exit(typeof code === "number" ? code : 0)
  })
}

const envPath = process.env.OCV_BIN_PATH
const scriptDir = path.dirname(fs.realpathSync(__filename))
const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[os.platform()] || os.platform()
const arch = { x64: "x64", arm64: "arm64", arm: "arm" }[os.arch()] || os.arch()
const base = `@leohenon/ocv-cli-${platform}-${arch}`
const binary = platform === "windows" ? "opencode.exe" : "opencode"

function supportsAvx2() {
  if (arch !== "x64") return false
  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }
  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], { encoding: "utf8", timeout: 1500 })
      return result.status === 0 && (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }
  return false
}

const names = (() => {
  const baseline = arch === "x64" && !supportsAvx2()
  if (platform === "linux") {
    const musl = (() => {
      try {
        if (fs.existsSync("/etc/alpine-release")) return true
        const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
        return ((result.stdout || "") + (result.stderr || "")).toLowerCase().includes("musl")
      } catch {
        return false
      }
    })()
    if (musl)
      return arch === "x64"
        ? baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
        : [`${base}-musl`, base]
    return arch === "x64"
      ? baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
      : [base, `${base}-musl`]
  }
  return arch === "x64" ? (baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]) : [base]
})()

const mismatches = new Set()
const wrapper = (() => {
  if (envPath) return
  try {
    return JSON.parse(fs.readFileSync(path.join(scriptDir, "..", "package.json"), "utf8"))
  } catch {
    console.error("Could not read the ocv package manifest. Reinstall @leohenon/ocv with your package manager.")
    process.exit(1)
  }
})()

function validatedBinary(name, directory) {
  const target = path.join(directory, "bin", binary)
  if (!fs.existsSync(target)) return
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
    const expected = wrapper.optionalDependencies?.[name]
    if (
      typeof wrapper.version !== "string" ||
      expected !== wrapper.version ||
      manifest.name !== name ||
      manifest.version !== expected
    ) {
      mismatches.add(`${name}: expected ${wrapper.version}, found ${manifest.version ?? "unknown"}`)
      return
    }
    return target
  } catch {
    mismatches.add(`${name}: missing or invalid package manifest`)
  }
}

function resolvePackageBinary() {
  for (const name of names) {
    try {
      const source = validatedBinary(name, path.dirname(require.resolve(`${name}/package.json`)))
      if (!source) continue
      if (!source.includes(".zip/") && !source.includes(".zip\\")) return { target: source }
      const target = path.join(os.tmpdir(), `ocv-${process.pid}${platform === "windows" ? ".exe" : ""}`)
      fs.copyFileSync(source, target)
      fs.chmodSync(target, 0o755)
      return { target, cleanup: () => fs.rmSync(target, { force: true }) }
    } catch {}
  }
}

function findBinary(startDir) {
  let current = startDir
  for (;;) {
    const modules = path.join(current, "node_modules")
    if (fs.existsSync(modules))
      for (const name of names) {
        const candidate = validatedBinary(name, path.join(modules, name))
        if (candidate) return candidate
      }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

// Old unversioned .ocv cache files must not bypass optional-package version checks.
// OCV_BIN_PATH remains an explicit override for custom binaries.
const physical = envPath || findBinary(scriptDir)
const packageBinary = physical ? undefined : resolvePackageBinary()
const resolved = physical || packageBinary?.target
if (!resolved) {
  if (mismatches.size) {
    console.error(
      `OCV native package version mismatch:\n${[...mismatches].join("\n")}\nReinstall @leohenon/ocv with your package manager.`,
    )
    process.exit(1)
  }
  console.error(
    "It seems that your package manager failed to install the right ocv CLI package. Try manually installing " +
      names.map((name) => `"${name}"`).join(" or ") +
      " package",
  )
  process.exit(1)
}
run(resolved, packageBinary?.cleanup)
