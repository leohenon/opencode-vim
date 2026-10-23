import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

const root = path.resolve(import.meta.dir, "../../..")

test("website generator reproduces the checked-in site with V1 and V2 install channels", async () => {
  await using directory = await tmpdir()
  await mkdir(path.join(directory.path, "docs"))
  const child = Bun.spawn([process.execPath, path.join(root, "docs/build.ts")], {
    cwd: directory.path,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(code, stderr).toBe(0)
  const generated = await Bun.file(path.join(directory.path, "docs/index.html")).text()
  expect(generated).toBe(await Bun.file(path.join(root, "docs/index.html")).text())
  expect(generated).toContain("npm i -g @leohenon/ocv@ocv-v2")
  expect(generated).toContain("npm i -g @leohenon/ocv@latest")
  expect(generated).toContain("brew install leohenon/tap/ocv-v2")
  expect(generated).toContain("/ocv1/install.sh")
  expect(generated).toContain("/blob/ocv1/README.md")
  expect(generated).toContain("opencode plugin add @leohenon/opencode-vim-plugin@beta")
  for (const match of generated.matchAll(/(?:src|href|url)\s*(?:=|\()\s*["']?(\.\/[^"')\s]+)/g)) {
    expect(await Bun.file(path.join(root, "docs", match[1]!)).exists()).toBe(true)
  }
})
