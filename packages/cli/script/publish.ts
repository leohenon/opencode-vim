#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode/script"
import { fileURLToPath } from "url"
import path from "node:path"

const dir = fileURLToPath(new URL("..", import.meta.url))
const root = path.resolve(process.env.OPENCODE_CLI_DIST ?? path.join(dir, "dist"))
process.chdir(dir)
const dryRun = process.argv.includes("--dry-run")

function requireVersion(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)-ocv\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/.test(value)
  ) {
    throw new Error(`Invalid OCV V2 version: ${value}`)
  }
  return value
}

async function registryVersion(spec: string, expected?: string) {
  const result = await $`npm view ${spec} version --json`.quiet().nothrow()
  const value: unknown = JSON.parse(result.stdout.toString() || "null")
  if (result.exitCode === 0) {
    const version = requireVersion(value)
    if (expected && version !== expected) throw new Error(`Expected ${spec} to resolve to ${expected}, got ${version}`)
    return version
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "code" in value.error &&
    value.error.code === "E404"
  )
    return undefined
  throw new Error(`npm lookup failed for ${spec}: ${result.stderr.toString()} ${JSON.stringify(value)}`)
}

async function publish(dir: string, name: string, version: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  const exists = !dryRun && (await registryVersion(`${name}@${version}`, version)) !== undefined
  if (exists) console.log(`already published ${name}@${version}`)
  // Keep local tarballs available to downstream publishers when retrying a release.
  await $`bun pm pack`.cwd(dir)
  if (!exists && !dryRun) await $`npm publish *.tgz --access public --tag ocv-v2`.cwd(dir)
}

async function publishDistribution(input: {
  root: string
  name: string
  command: string
  legacyCommand?: string
  packagePrefix: string
}) {
  const binaries: Record<string, string> = {}
  for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: input.root })) {
    const item = await Bun.file(`${input.root}/${filepath}`).json()
    if (!item.name.startsWith(input.packagePrefix)) continue
    binaries[item.name] = item.version
  }
  console.log(input.name, "binaries", binaries)
  const versions = new Set(Object.values(binaries))
  if (versions.size > 1) throw new Error(`Binary package versions do not match for ${input.name}`)
  const version = versions.values().next().value
  if (!version) throw new Error(`No binary packages found for ${input.name}`)
  if (version !== Script.version) throw new Error(`Expected ${Script.version}, got ${version} for ${input.name}`)

  requireVersion(version)
  if (!dryRun) {
    const current = await registryVersion(`${input.name}@ocv-v2`)
    if (current && Bun.semver.order(version, current) < 0) {
      throw new Error(`Refusing to downgrade ocv-v2 from ${current} to ${version}`)
    }
  }

  await $`mkdir -p ${input.root}/${input.name}/bin`
  await Bun.write(`${input.root}/${input.name}/bin/${input.command}.cjs`, Bun.file(path.join(dir, "bin", "ocv.cjs")))
  await Bun.file(`${input.root}/${input.name}/package.json`).write(
    JSON.stringify(
      {
        name: input.name,
        bin: {
          [input.command]: `./bin/${input.command}.cjs`,
          ...(input.legacyCommand ? { [input.legacyCommand]: `./bin/${input.command}.cjs` } : {}),
        },
        version,
        license: pkg.license,
        repository: { type: "git", url: "git+https://github.com/leohenon/opencode-vim.git" },
        os: ["darwin", "linux", "win32"],
        cpu: ["arm64", "x64"],
        optionalDependencies: binaries,
      },
      null,
      2,
    ),
  )

  await Promise.all(
    Object.entries(binaries).map(([name, version]) =>
      publish(`${input.root}/cli-${name.slice(input.packagePrefix.length)}`, name, version),
    ),
  )
  await publish(`${input.root}/${input.name}`, input.name, version)
  if (!dryRun) {
    // A retry may find the immutable package already published but its channel missing or stale.
    const current = await registryVersion(`${input.name}@ocv-v2`)
    if (!current || Bun.semver.order(current, version) < 0) {
      await $`npm dist-tag add ${input.name}@${version} ocv-v2`
    }
  }
}

await publishDistribution({
  root,
  name: pkg.name,
  command: "ocv",
  packagePrefix: "@leohenon/ocv-cli-",
})
// OCV GitHub/Homebrew publishing is owned by publish-ocv.yml. Keeping those
// steps out of this npm packager prevents accidental upstream image or tap updates.
