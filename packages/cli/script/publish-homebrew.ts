#!/usr/bin/env bun
import { Script } from "@opencode/script"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
if (!/^\d+\.\d+\.\d+-ocv\.\d+\.\d+$/.test(Script.version)) {
  throw new Error("Expected an OCV V2 release version")
}

const dir = fileURLToPath(new URL("..", import.meta.url))
const dist = path.resolve(process.env.OPENCODE_CLI_DIST ?? path.join(dir, "dist"))
const root = path.join(dist, "release")
const outdir = root
const publish = process.argv.includes("--publish")
const name = "ocv-v2"
const formulaClass = "OcvV2"

const targets = await Promise.all(
  [
    { name: "darwin-arm64", archive: "zip" },
    { name: "darwin-x64-baseline", archive: "zip" },
    { name: "linux-arm64", archive: "tar.gz" },
    { name: "linux-x64-baseline", archive: "tar.gz" },
  ].map(async (target) => {
    const filename = `ocv-${target.name}.${target.archive}`
    const file = Bun.file(path.join(root, filename))
    if (!(await file.exists()) || !file.size) throw new Error(`Missing Homebrew archive: ${filename}`)
    const sha256 = new Bun.CryptoHasher("sha256")
    for await (const chunk of file.stream()) sha256.update(chunk)
    return {
      ...target,
      url: `https://github.com/leohenon/opencode-vim/releases/download/v${encodeURIComponent(Script.version)}/${filename}`,
      sha256: sha256.digest("hex"),
    }
  }),
)

await mkdir(outdir, { recursive: true })

const target = (name: string) => {
  const result = targets.find((item) => item.name === name)
  if (!result) throw new Error(`Missing Homebrew target: ${name}`)
  return result
}
const macArm = target("darwin-arm64")
const macIntel = target("darwin-x64-baseline")
const linuxArm = target("linux-arm64")
const linuxIntel = target("linux-x64-baseline")

await Bun.write(
  path.join(outdir, `${name}.rb`),
  [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    `class ${formulaClass} < Formula`,
    '  desc "OpenCode V2 with first-class Vim and transcript copy modes"',
    '  homepage "https://github.com/leohenon/opencode-vim"',
    `  version "${Script.version}"`,
    '  license "MIT"',
    "",
    '  depends_on "ripgrep"',
    '  conflicts_with "ocv", because: "both install the ocv command"',

    "  on_macos do",
    "    if Hardware::CPU.arm?",
    `      url "${macArm.url}"`,
    `      sha256 "${macArm.sha256}"`,
    "    else",
    `      url "${macIntel.url}"`,
    `      sha256 "${macIntel.sha256}"`,
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.arm?",
    `      url "${linuxArm.url}"`,
    `      sha256 "${linuxArm.sha256}"`,
    "    else",
    `      url "${linuxIntel.url}"`,
    `      sha256 "${linuxIntel.sha256}"`,
    "    end",
    "  end",
    "",
    "  def install",
    '    bin.install "opencode" => "ocv"',
    "  end",
    "end",
    "",
  ].join("\n"),
)
console.log(`Prepared ${name} ${Script.version} in ${outdir}`)
if (publish) {
  throw new Error("Homebrew tap publication is owned by publish-ocv.yml; this script only generates the formula")
}
