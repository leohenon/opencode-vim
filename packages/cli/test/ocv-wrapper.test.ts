import { expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { tmpdir } from "./fixture/tmpdir"

const unix = process.platform === "win32" ? test.skip : test
const version = "2.1.2-ocv.4.13"
const oldVersion = "2.1.1-ocv.4.13"

async function fixture(root: string, nativeVersion = version, modules = path.join(root, "node_modules")) {
  const wrapper = path.join(root, "node_modules", "@leohenon", "ocv", "bin", "ocv.cjs")
  await mkdir(path.dirname(wrapper), { recursive: true })
  await Bun.write(wrapper, Bun.file(path.join(import.meta.dir, "..", "bin", "ocv.cjs")))
  const platform = process.platform === "darwin" ? "darwin" : "linux"
  const base = `@leohenon/ocv-cli-${platform}-${process.arch}`
  const names = ["", "-baseline", "-musl", "-baseline-musl"].map((suffix) => base + suffix)
  const manifest = path.join(path.dirname(wrapper), "..", "package.json")
  await Bun.write(
    manifest,
    JSON.stringify({
      name: "@leohenon/ocv",
      version,
      optionalDependencies: Object.fromEntries(names.map((name) => [name, version])),
    }),
  )
  const packages = names.map((name) => path.join(modules, name))
  for (const [index, directory] of packages.entries()) {
    await mkdir(path.join(directory, "bin"), { recursive: true })
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({ name: names[index], version: nativeVersion }),
    )
    const binary = path.join(directory, "bin", "opencode")
    await writeFile(binary, "#!/bin/sh\nprintf '%s' \"$*\"\n")
    await chmod(binary, 0o755)
  }
  return { wrapper, packages, names, manifest }
}

async function run(
  root: string,
  wrapper: string,
  env: Record<string, string | undefined> = {},
  runtime = process.execPath,
) {
  const child = Bun.spawn([runtime, wrapper, "--version", "wrapper-test"], {
    stdout: "pipe",
    stderr: "pipe",
    env: isolatedEnv(root, { OCV_BIN_PATH: undefined, NODE_PATH: undefined, ...env }),
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

unix("npm wrapper runs a matching platform package without lifecycle scripts", async () => {
  await using directory = await tmpdir()
  const test = await fixture(directory.path)
  const result = await run(directory.path, test.wrapper)
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toBe("--version wrapper-test")
})

unix("npm wrapper refuses mismatched native versions before executing them", async () => {
  await using directory = await tmpdir()
  const test = await fixture(directory.path, oldVersion)
  const result = await run(directory.path, test.wrapper)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain(`expected ${version}, found ${oldVersion}`)
  expect(result.stderr).toContain("Reinstall @leohenon/ocv")
})

unix("npm wrapper requires exact optional dependency metadata and native identity", async () => {
  await using directory = await tmpdir()
  const test = await fixture(directory.path)
  for (const directory of test.packages)
    await Bun.write(path.join(directory, "package.json"), JSON.stringify({ name: "unrelated-package", version }))
  const wrongIdentity = await run(directory.path, test.wrapper)
  expect(wrongIdentity.code).toBe(1)
  expect(wrongIdentity.stdout).toBe("")
  for (const [index, directory] of test.packages.entries())
    await Bun.write(path.join(directory, "package.json"), JSON.stringify({ name: test.names[index], version }))
  const manifest = await Bun.file(test.manifest).json()
  await Bun.write(test.manifest, JSON.stringify({ ...manifest, optionalDependencies: {} }))
  const result = await run(directory.path, test.wrapper)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
})

unix("unversioned cache files cannot bypass native package validation", async () => {
  await using directory = await tmpdir()
  const test = await fixture(directory.path, oldVersion)
  const cached = path.join(path.dirname(test.wrapper), ".ocv")
  await Bun.write(cached, "#!/bin/sh\nprintf 'stale-cache'\n")
  await chmod(cached, 0o755)
  const result = await run(directory.path, test.wrapper)
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
})

unix("an explicit OCV_BIN_PATH override still supports custom binaries", async () => {
  await using directory = await tmpdir()
  const test = await fixture(directory.path, oldVersion)
  const override = path.join(directory.path, "custom-ocv")
  await Bun.write(override, "#!/bin/sh\nprintf 'custom-binary'\n")
  await chmod(override, 0o755)
  const result = await run(directory.path, test.wrapper, { OCV_BIN_PATH: override })
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout).toBe("custom-binary")
})

unix("Node module resolution also refuses mismatched native versions", async () => {
  await using directory = await tmpdir()
  const modules = path.join(directory.path, "store", "node_modules")
  const test = await fixture(directory.path, oldVersion, modules)
  const result = await run(directory.path, test.wrapper, { NODE_PATH: modules }, "node")
  expect(result.code).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain(`expected ${version}, found ${oldVersion}`)
  for (const [index, directory] of test.packages.entries())
    await Bun.write(path.join(directory, "package.json"), JSON.stringify({ name: test.names[index], version }))
  const matching = await run(directory.path, test.wrapper, { NODE_PATH: modules }, "node")
  expect(matching.code, matching.stderr).toBe(0)
  expect(matching.stdout).toBe("--version wrapper-test")
})
