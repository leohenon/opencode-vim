import { intro, log, outro, spinner } from "@clack/prompts"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { handlePromptErrors } from "../../ui/prompt"
import { errorMessage } from "../../util/error"
import { OPENCODE_VERSION } from "../../version"

// ocv: `ocv update` replaces the running binary with the latest ocv release.
// Upstream's `upgrade` command talks to the opencode.ai update service, which
// does not publish the ocv builds.
const REPO = "leohenon/opencode-vim"

function target() {
  const platform = os.platform()
  const arch = os.arch()
  const p = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : undefined
  if (!p) throw new Error(`Unsupported platform: ${platform}`)
  const a = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined
  if (!a) throw new Error(`Unsupported architecture: ${arch}`)
  return { platform: p, arch: a }
}

const latest = Effect.fnUntraced(function* () {
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal }),
    catch: (cause) => cause,
  })
  if (!response.ok) throw new Error(`Failed to fetch latest release: ${response.statusText}`)
  const data = (yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => cause,
  })) as { tag_name: string }
  return data.tag_name.replace(/^v/, "")
})

const download = Effect.fnUntraced(function* (version: string) {
  const t = target()
  const name = `ocv-${t.platform}-${t.arch}`
  const ext = t.platform === "linux" ? "tar.gz" : "zip"
  const url = `https://github.com/${REPO}/releases/download/v${version}/${name}.${ext}`
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(url, { signal }),
    catch: (cause) => cause,
  })
  if (!response.ok) throw new Error(`Download failed: ${response.statusText}`)
  const buffer = yield* Effect.promise(() => response.arrayBuffer())
  return { data: Buffer.from(buffer), ext }
})

const extract = Effect.fnUntraced(function* (data: Buffer, ext: string, dir: string) {
  if (ext === "tar.gz") {
    const tar = path.join(dir, "ocv.tar.gz")
    yield* Effect.promise(() => fs.writeFile(tar, data))
    const proc = yield* Effect.sync(() => Bun.spawn(["tar", "-xzf", tar, "-C", dir]))
    const code = yield* Effect.promise(() => proc.exited)
    if (code !== 0) throw new Error("Failed to extract tar.gz")
    return
  }
  const zip = path.join(dir, "ocv.zip")
  yield* Effect.promise(() => fs.writeFile(zip, data))
  const proc = yield* Effect.sync(() => Bun.spawn(["unzip", "-q", "-o", zip, "-d", dir]))
  const code = yield* Effect.promise(() => proc.exited)
  if (code !== 0) throw new Error("Failed to extract zip")
})

const install = Effect.fnUntraced(function* (data: Buffer, ext: string) {
  const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "ocv-")))
  try {
    yield* extract(data, ext, tmp)
    const bin = path.join(tmp, "opencode")
    const dest = process.execPath
    const staging = dest + ".tmp"
    yield* Effect.promise(() => fs.copyFile(bin, staging))
    yield* Effect.promise(() => fs.chmod(staging, 0o755))
    yield* Effect.promise(() => fs.rename(staging, dest))
  } finally {
    yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true })).pipe(Effect.ignore)
  }
})

export default Runtime.handler(
  Commands.commands.update,
  Effect.fn("cli.update")(
    function* () {
      intro("Update")

      const progress = spinner()
      progress.start("Checking for updates...")
      const version = yield* latest()
      progress.stop(`Latest version: ${version}`)

      if (OPENCODE_VERSION === version) {
        log.warn(`Already on the latest version (${version})`)
        outro("Done")
        return
      }

      log.info(`${OPENCODE_VERSION} → ${version}`)

      progress.start("Downloading...")
      const result = yield* download(version).pipe(Effect.exit)
      if (Exit.isFailure(result)) {
        progress.stop("Download failed", 1)
        log.error(errorMessage(result.cause))
        outro("Done")
        return
      }
      progress.stop("Downloaded")

      progress.start("Installing...")
      const installed = yield* install(result.value.data, result.value.ext).pipe(Effect.exit)
      if (Exit.isFailure(installed)) {
        progress.stop("Install failed", 1)
        log.error(errorMessage(installed.cause))
        outro("Done")
        return
      }
      progress.stop("Installed")

      log.success(`Updated to ${version}`)
      outro("Done")
    },
    (effect) => handlePromptErrors(effect),
  ),
)
