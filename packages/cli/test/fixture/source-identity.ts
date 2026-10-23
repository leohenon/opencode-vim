import path from "node:path"
import { CLI_NAME, PRODUCT_NAME } from "@opencode/util/identity"
import { Global } from "@opencode/util/global"
import { selfCommand } from "../../src/util/process"

const identity = () => ({
  cli: CLI_NAME,
  product: PRODUCT_NAME,
  config: Global.Path.config,
  data: Global.Path.data,
  runtime: process.execPath,
})

if (process.argv.includes("--identity-child")) {
  process.stdout.write(JSON.stringify(identity()))
} else {
  const command = selfCommand()
  const child = Bun.spawn([...command, "--identity-child"], {
    cwd: path.parse(process.cwd()).root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) {
    process.stderr.write(stderr)
    process.exit(code)
  }
  process.stdout.write(JSON.stringify({ parent: identity(), child: JSON.parse(stdout) }))
}
