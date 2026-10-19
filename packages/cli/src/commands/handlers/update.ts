import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Installation } from "../../installation"
import fs from "fs/promises"
import os from "os"
import path from "path"

const REPO = "leohenon/opencode-vim"

async function latest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  if (!res.ok) throw new Error(`Failed to fetch latest release: ${res.statusText}`)
  const data = (await res.json()) as { tag_name: string }
  return data.tag_name.replace(/^v/, "")
}

function target() {
  const platform = os.platform()
  const arch = os.arch()
  const p = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null
  if (!p) throw new Error(`Unsupported platform: ${platform}`)
  const a = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null
  if (!a) throw new Error(`Unsupported architecture: ${arch}`)
  return { platform: p, arch: a }
}

async function download(version: string) {
  const t = target()
  const name = `ocv-${t.platform}-${t.arch}`
  const ext = t.platform === "linux" ? "tar.gz" : "zip"
  const url = `https://github.com/${REPO}/releases/download/v${version}/${name}.${ext}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed: ${res.statusText}`)
  return { data: Buffer.from(await res.arrayBuffer()), ext }
}

async function extract(data: Buffer, ext: string, dir: string) {
  if (ext === "tar.gz") {
    const tar = path.join(dir, "ocv.tar.gz")
    await fs.writeFile(tar, data)
    const proc = Bun.spawn(["tar", "-xzf", tar, "-C", dir])
    await proc.exited
    if (proc.exitCode !== 0) throw new Error("Failed to extract tar.gz")
  } else {
    const zip = path.join(dir, "ocv.zip")
    await fs.writeFile(zip, data)
    const proc = Bun.spawn(["unzip", "-q", "-o", zip, "-d", dir])
    await proc.exited
    if (proc.exitCode !== 0) throw new Error("Failed to extract zip")
  }
}

export const UpdateCommand = {
  command: "update",
  describe: "update ocv to the latest version",
  handler: async () => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Update")

    const spinner = prompts.spinner()
    spinner.start("Checking for updates...")
    const version = await latest()
    spinner.stop(`Latest version: ${version}`)

    if (Installation.VERSION === version) {
      prompts.log.warn(`Already on the latest version (${version})`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`${Installation.VERSION} → ${version}`)

    spinner.start("Downloading...")
    const result = await download(version).catch((e) => e as Error)
    if (result instanceof Error) {
      spinner.stop("Download failed", 1)
      prompts.log.error(result.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Downloaded")

    const spinner2 = prompts.spinner()
    spinner2.start("Installing...")
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ocv-"))
    const err = await (async () => {
      try {
        await extract(result.data, result.ext, tmp)
        const bin = path.join(tmp, "opencode")
        const dest = process.execPath
        const staging = dest + ".tmp"
        await fs.copyFile(bin, staging)
        await fs.chmod(staging, 0o755)
        await fs.rename(staging, dest)
      } finally {
        await fs.rm(tmp, { recursive: true, force: true })
      }
    })().catch((e) => e as Error)
    if (err) {
      spinner2.stop("Install failed", 1)
      prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner2.stop("Installed")

    prompts.log.success(`Updated to ${version}`)
    prompts.outro("Done")
  },
}
