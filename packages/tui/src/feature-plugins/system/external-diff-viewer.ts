import type { CliRenderer } from "@opentui/core"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"

export async function openExternalDiffViewer(input: {
  command: ReadonlyArray<string>
  directory: string
  renderer: CliRenderer
}) {
  const [executable, ...args] = input.command
  if (!executable) throw new Error("External diff viewer command is empty")
  if (!existsSync(input.directory)) throw new Error(`Diff directory does not exist: ${input.directory}`)

  const ignoreSigint = () => {}
  input.renderer.suspend()
  input.renderer.currentRenderBuffer.clear()
  process.on("SIGINT", ignoreSigint)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: input.directory,
        stdio: "inherit",
        shell: process.platform === "win32",
      })
      child.once("error", reject)
      child.once("close", (code, signal) => {
        if (code === 0) return resolve()
        reject(
          new Error(`External diff viewer exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`),
        )
      })
    })
  } finally {
    try {
      input.renderer.currentRenderBuffer.clear()
      input.renderer.resume()
      input.renderer.requestRender()
    } finally {
      process.off("SIGINT", ignoreSigint)
    }
  }
}
