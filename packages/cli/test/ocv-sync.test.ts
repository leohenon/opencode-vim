import { expect, test } from "bun:test"
import { mergePackageMetadata } from "../script/ocv-sync"

const json = (value: object) => JSON.stringify(value, null, 2) + "\n"
const base = { name: "@opencode/cli", version: "2.1.2", license: "MIT", bin: { opencode: "bin/opencode.cjs" } }
const ours = { ...base, name: "@leohenon/ocv", version: "2.1.2-ocv.4.13", bin: { ocv: "bin/ocv.cjs" } }
const theirs = { ...base, version: "2.1.3" }

test("an upstream package version bump retains the OCV package and executable", async () => {
  const merged = await mergePackageMetadata("packages/cli/package.json", {
    base: json(base),
    ours: json(ours),
    theirs: json(theirs),
  })
  expect(JSON.parse(merged)).toEqual({ ...ours, version: "2.1.3" })
})

test("a workspace lock version bump retains OCV identity and unrelated upstream updates", async () => {
  const lock = (cli: object, version: string) =>
    json({ workspaces: { "packages/ai": { name: "@opencode/ai", version }, "packages/cli": cli } })
  const merged = await mergePackageMetadata("bun.lock", {
    base: lock(base, "2.1.2"),
    ours: lock(ours, "2.1.2"),
    theirs: lock(theirs, "2.1.3"),
  })
  expect(JSON.parse(merged)).toEqual({
    workspaces: {
      "packages/ai": { name: "@opencode/ai", version: "2.1.3" },
      "packages/cli": { ...ours, version: "2.1.3" },
    },
  })
})

test("real conflicts are not resolved by choosing the fork or upstream wholesale", async () => {
  await expect(
    mergePackageMetadata("packages/cli/package.json", {
      base: json({ ...base, dependencies: { example: "1" } }),
      ours: json({ ...ours, dependencies: { example: "2" } }),
      theirs: json({ ...theirs, dependencies: { example: "3" } }),
    }),
  ).rejects.toThrow("Non-metadata conflict")
})

test("rejects upstream major-version and package-identity transitions", async () => {
  for (const replacement of [
    { ...theirs, version: "3.0.0" },
    { ...theirs, name: "@opencode/new-cli" },
  ]) {
    await expect(
      mergePackageMetadata("packages/cli/package.json", {
        base: json(base),
        ours: json(ours),
        theirs: json(replacement),
      }),
    ).rejects.toThrow()
  }
})

test("root version bumps preserve fork metadata without blocking upstream changes", async () => {
  const root = {
    name: "opencode",
    description: "AI-powered development tool",
    version: "2.1.2",
    private: true,
    type: "module",
    packageManager: "bun@1.4.2",
    scripts: { dev: "upstream" },
  }
  const fork = { ...root, name: "ocv", description: "OpenCode with Vim", scripts: { dev: "fork" } }
  const merged = await mergePackageMetadata("package.json", {
    base: json(root),
    ours: json(fork),
    theirs: json({ ...root, version: "2.1.4", packageManager: "bun@1.4.4" }),
  })
  expect(JSON.parse(merged)).toEqual({ ...fork, version: "2.1.4", packageManager: "bun@1.4.4" })
})

test("root dependency conflicts still require manual review", async () => {
  const root = { name: "opencode", version: "2.1.2", dependencies: { example: "1" } }
  await expect(
    mergePackageMetadata("package.json", {
      base: json(root),
      ours: json({ ...root, name: "ocv", dependencies: { example: "2" } }),
      theirs: json({ ...root, version: "2.1.4", dependencies: { example: "3" } }),
    }),
  ).rejects.toThrow("Non-metadata conflict")
})
