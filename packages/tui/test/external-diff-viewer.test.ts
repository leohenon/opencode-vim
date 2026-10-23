import { expect, test } from "bun:test"
import type { CliRenderer } from "@opentui/core"
import { externalDiffSpawnOptions, openExternalDiffViewer } from "../src/feature-plugins/system/external-diff-viewer"

function renderer() {
  const events: string[] = []
  return {
    events,
    value: {
      suspend: async () => {
        events.push("suspend")
      },
      resume: async () => {
        events.push("resume")
      },
      requestRender: () => events.push("render"),
      currentRenderBuffer: { clear: () => events.push("clear") },
    } as unknown as CliRenderer,
  }
}

test("uses argument-array spawning without a shell on every platform", () => {
  expect(externalDiffSpawnOptions("C:\\workspace")).toEqual({
    cwd: "C:\\workspace",
    stdio: "inherit",
    shell: false,
  })
})

test("runs the configured command and restores the renderer", async () => {
  const output = renderer()
  const sigintListeners = process.listenerCount("SIGINT")

  const pending = openExternalDiffViewer({
    command: [process.execPath, "-e", "process.exit(0)"],
    directory: process.cwd(),
    renderer: output.value,
  })
  await pending

  expect(output.events).toEqual(["suspend", "resume", "render"])
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

  expect(output.events).toEqual(["suspend", "resume", "render"])
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

  expect(output.events).toEqual(["suspend", "resume", "render"])
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

test("waits for terminal suspension and resumption before advancing the handoff", async () => {
  const output = renderer()
  const suspended = Promise.withResolvers<void>()
  const resumeStarted = Promise.withResolvers<void>()
  const resumed = Promise.withResolvers<void>()
  const sigintListeners = process.listenerCount("SIGINT")
  output.value.suspend = async () => {
    output.events.push("suspend")
    await suspended.promise
  }
  output.value.resume = async () => {
    output.events.push("resume")
    resumeStarted.resolve()
    await resumed.promise
  }
  const pending = openExternalDiffViewer({
    command: [process.execPath, "-e", "process.exit(0)"],
    directory: process.cwd(),
    renderer: output.value,
  })
  try {
    expect(output.events).toEqual(["suspend"])
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners)
    suspended.resolve()
    await resumeStarted.promise
    expect(output.events).toEqual(["suspend", "resume"])
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1)
    resumed.resolve()
    await pending
    expect(output.events).toEqual(["suspend", "resume", "render"])
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners)
  } finally {
    suspended.resolve()
    resumed.resolve()
    await pending
  }
})
