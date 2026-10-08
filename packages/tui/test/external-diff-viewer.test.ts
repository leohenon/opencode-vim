import { expect, test } from "bun:test"
import type { CliRenderer } from "@opentui/core"
import { openExternalDiffViewer } from "../src/feature-plugins/system/external-diff-viewer"

function renderer() {
  const events: string[] = []
  return {
    events,
    value: {
      suspend: () => events.push("suspend"),
      resume: () => events.push("resume"),
      requestRender: () => events.push("render"),
      currentRenderBuffer: { clear: () => events.push("clear") },
    } as unknown as CliRenderer,
  }
}

test("runs the configured command and restores the renderer", async () => {
  const output = renderer()
  const sigintListeners = process.listenerCount("SIGINT")

  const pending = openExternalDiffViewer({
    command: [process.execPath, "-e", "process.exit(0)"],
    directory: process.cwd(),
    renderer: output.value,
  })
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1)
  await pending

  expect(output.events).toEqual(["suspend", "clear", "clear", "resume", "render"])
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners)
})

test("restores the renderer when the configured command fails", async () => {
  const output = renderer()
  const sigintListeners = process.listenerCount("SIGINT")

  await expect(
    openExternalDiffViewer({
      command: [process.execPath, "-e", "process.exit(7)"],
      directory: process.cwd(),
      renderer: output.value,
    }),
  ).rejects.toThrow("code 7")

  expect(output.events).toEqual(["suspend", "clear", "clear", "resume", "render"])
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners)
})

test("restores the renderer when the executable is missing", async () => {
  const output = renderer()
  const sigintListeners = process.listenerCount("SIGINT")

  await expect(
    openExternalDiffViewer({
      command: ["opencode-external-diff-viewer-that-does-not-exist"],
      directory: process.cwd(),
      renderer: output.value,
    }),
  ).rejects.toThrow()

  expect(output.events).toEqual(["suspend", "clear", "clear", "resume", "render"])
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners)
})

test("rejects an inaccessible diff directory before suspending", async () => {
  const output = renderer()

  await expect(
    openExternalDiffViewer({
      command: [process.execPath],
      directory: "/opencode/diff-viewer-directory-that-does-not-exist",
      renderer: output.value,
    }),
  ).rejects.toThrow("Diff directory does not exist")

  expect(output.events).toEqual([])
})
