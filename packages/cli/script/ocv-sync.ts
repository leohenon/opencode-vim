import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Let Git merge the content after removing only the known package-identity/version conflict. */
export async function mergePackageMetadata(file: string, input: { base: string; ours: string; theirs: string }) {
  if (file !== "package.json" && file !== "packages/cli/package.json" && file !== "bun.lock")
    throw new Error(`Unsupported merge file: ${file}`)
  const prefix = file === "bun.lock" ? ["workspaces", "packages/cli"] : []
  const identity =
    file === "package.json"
      ? { upstream: "opencode", fork: "ocv" }
      : { upstream: "@opencode/cli", fork: "@leohenon/ocv" }
  const values = [input.base, input.ours, input.theirs].map((text) => {
    const errors: ParseError[] = []
    const value = parse(text, errors, { allowTrailingComma: true })
    if (errors.length) throw new Error(`Invalid JSON in ${file}`)
    const pkg = prefix.length ? value?.workspaces?.["packages/cli"] : value
    if (typeof pkg?.name !== "string" || typeof pkg?.version !== "string")
      throw new Error(`Missing package identity in ${file}`)
    return pkg as { name: string; version: string }
  })
  if (values[0]!.name !== identity.upstream || values[2]!.name !== values[0]!.name)
    throw new Error(`Upstream package identity changed in ${file}`)
  if (values[1]!.name !== identity.fork) throw new Error(`Unexpected OCV identity in ${file}`)
  if (!values.every((value) => /^2\.\d+\.\d+(?:-ocv\.\d+\.\d+)?$/.test(value.version)))
    throw new Error(`Refusing a non-V2 package merge in ${file}`)
  const normalized = [input.base, input.ours, input.theirs].map((text) =>
    Object.entries({ name: values[1]!.name, version: values[2]!.version }).reduce(
      (result, [key, value]) =>
        applyEdits(
          result,
          modify(result, [...prefix, key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
        ),
      text,
    ),
  )
  const directory = await mkdtemp(path.join(os.tmpdir(), "ocv-merge-"))
  try {
    const files = ["base", "ours", "theirs"].map((name) => path.join(directory, name))
    await Promise.all(files.map((file, index) => Bun.write(file, normalized[index]!)))
    const result = Bun.spawnSync(["git", "merge-file", "-p", files[1]!, files[0]!, files[2]!])
    if (result.exitCode !== 0) throw new Error(`Non-metadata conflict in ${file}; manual review required`)
    return result.stdout.toString()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Only exact upstream guards are accepted; compound conditions still need review. */
export function isUpstreamOnlyWorkflow(text: string) {
  const workflow = Bun.YAML.parse(text) as { jobs?: Record<string, { if?: unknown }> } | null
  const jobs = Object.values(workflow?.jobs ?? {})
  return (
    jobs.length > 0 &&
    jobs.every((job) =>
      ["github.repository == 'anomalyco/opencode'", "${{ github.repository == 'anomalyco/opencode' }}"].includes(
        typeof job?.if === "string" ? job.if.trim() : "",
      ),
    )
  )
}

if (import.meta.main) {
  for (const file of process.argv.slice(2)) {
    const read = (stage: number) => {
      const result = Bun.spawnSync(["git", "show", `:${stage}:${file}`])
      if (result.exitCode !== 0) throw new Error(`Missing merge stage ${stage} for ${file}`)
      return result.stdout.toString()
    }
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) {
      const unmerged = Bun.spawnSync(["git", "ls-files", "--unmerged", "--", file])
      const stages = Array.from(unmerged.stdout.toString().matchAll(/^\d+ [0-9a-f]+ ([123])\t/gm), (match) => match[1])
      if (unmerged.exitCode !== 0 || stages.join(",") !== "1,2" || !isUpstreamOnlyWorkflow(read(2)))
        throw new Error(`Workflow conflict in ${file}; manual review required`)
      const result = Bun.spawnSync(["git", "rm", "--", file])
      if (result.exitCode !== 0) throw new Error(`Failed to stage upstream workflow deletion: ${file}`)
      continue
    }
    const merged = await mergePackageMetadata(file, { base: read(1), ours: read(2), theirs: read(3) })
    await Bun.write(file, merged)
    const result = Bun.spawnSync(["git", "add", "--", file])
    if (result.exitCode !== 0) throw new Error(`Failed to stage ${file}`)
  }
}
