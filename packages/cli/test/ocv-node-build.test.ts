import { expect, test } from "bun:test"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"

test("Node builds embed OCV identity and do not share the official native-asset cache", async () => {
  await using tmp = await tmpdir()
  // A fresh process matches build-node.ts: Vite loads before Babel transforms install
  // an Error.prepareStackTrace wrapper that breaks Vite's follow-redirects import in Bun.
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixture/ocv-node-build-probe.ts`], {
    cwd: tmp.path,
    env: isolatedEnv(tmp.path),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe("")
  expect(exitCode).toBe(0)
  expect(stdout).toBe("")
})
