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
  expect(generated).not.toContain("V1 usage and configuration")
  expect(generated).toContain("opencode plugin add @leohenon/opencode-vim-plugin@beta")
  expect(generated).toContain("opencode plugin @leohenon/opencode-vim-plugin@0.1.6 --global")
  expect(generated).toContain('aria-label="Plugin OpenCode version"')
  expect(generated).toContain('data-plugin-version="v1"')
  expect(generated).toContain('data-plugin-version="v2"')
  expect(generated).toMatch(/data-plugin-version="v1"[^>]*>v1 \(stable\)<\/button>\s*<a id="plugin-instructions"/)
  expect(generated).not.toContain('class="panel-bar"')
  expect(generated).toContain("For OpenCode v2 (2.0.25+).")
  expect(generated).toContain("For OpenCode v1 (1.17.10+).")
  expect(generated).toContain("opencode-vim-plugin/tree/v1#installation")
  expect(generated).not.toContain(">Docs</a>")
  for (const match of generated.matchAll(/(?:src|href|url)\s*(?:=|\()\s*["']?(\.\/[^"')\s]+)/g)) {
    expect(await Bun.file(path.join(root, "docs", match[1]!)).exists()).toBe(true)
  }
})
