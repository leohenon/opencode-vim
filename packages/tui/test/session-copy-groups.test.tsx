import { expect, test } from "bun:test"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "solid-js"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import type { SessionMessageInfo } from "@opencode/client"
import { createCopyMode, type CopyTarget } from "../src/routes/session/copy-mode"
import { copyHeaders } from "../src/routes/session/copy-geometry"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// Exercise the real V2 grouping/render tree, not a flattened approximation of it.
test("copy geometry follows expanded activity, reasoning and exploration descendants", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 50, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const session = {
    id: "ses_copy_groups",
    title: "Copy groups",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const tool = (id: string, name: string, input: Record<string, string>, output = "") => ({
    type: "tool" as const,
    id,
    name,
    time: { created: 1, completed: 2 },
    state: {
      status: "completed" as const,
      input,
      metadata: {},
      content: [{ type: "text" as const, text: output }] as [{ type: "text"; text: string }],
    },
  })
  const history: SessionMessageInfo[] = [
    { type: "user", id: "user", text: "Copy grouped activity", time: { created: 0 } },
    {
      type: "assistant",
      id: "assistant",
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      time: { created: 1, completed: 3 },
      finish: "stop",
      content: [
        { type: "reasoning", text: "**Plan title**\n\nNested thought 界 body", time: { created: 1, completed: 2 } },
        tool("grep", "grep", { pattern: "needle" }, "found needle"),
        tool(
          "shell",
          "shell",
          { command: "echo copy-shell-marker" },
          Array.from({ length: 12 }, (_, i) => `output ${i}`).join("\n"),
        ),
        tool("generic", "custom_tool", { value: "copy-generic-marker" }, "generic output"),
        tool("task", "subagent", { description: "copy-task-marker", prompt: "inspect", subagent_type: "explore" }),
        {
          ...tool("edit", "edit", { path: "copy.ts" }),
          state: {
            ...tool("edit", "edit", {}).state,
            metadata: {
              files: [
                {
                  type: "update",
                  relativePath: "copy.ts",
                  filePath: "copy.ts",
                  additions: 1,
                  deletions: 1,
                  patch: "--- a/copy.ts\n+++ b/copy.ts\n@@ -1 +1 @@\n-before-copy\n+after-copy\n",
                },
              ],
            },
          },
        },
        { type: "text", text: "Final copy marker" },
      ],
    },
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: history.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
      return json({ data: [] })
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ vim: false, animations: false, tabs: { enabled: false }, session: { verbosity: "low" } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  let dispose = () => {}
  try {
    await setup.waitForFrame((frame) => frame.includes("Final copy marker"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)]
    const clickHeader = async (label: string) => {
      const y = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes(label))
      expect(y).toBeGreaterThan(0)
      await setup.mockMouse.click(8, y)
      await setup.waitForVisualIdle({ quietFrames: 3 })
    }
    const activity = walk(setup.renderer.root).find((node) => copyHeaders.has(node))
    expect(activity).toBeDefined()
    const label = walk(activity!).find((node) => "plainText" in node && String(node.plainText).length > 3)
    expect(label).toBeDefined()
    await clickHeader(String((label as any).plainText))
    await setup.waitForFrame((frame) => frame.includes("copy-shell-marker"))
    // Expand nested disclosures without changing normal upstream grouping.
    await clickHeader("Thought")
    await setup.waitForFrame((frame) => frame.includes("Nested thought"))
    await clickHeader("Explored:")
    await setup.waitForFrame((frame) => frame.includes("needle"))
    const scroll = walk(setup.renderer.root).find(
      (node) =>
        node instanceof ScrollBoxRenderable &&
        node.getChildren().some((child) => walk(child).some((item) => copyHeaders.has(item))),
    ) as ScrollBoxRenderable
    expect(scroll).toBeDefined()
    const targets = () =>
      scroll
        .getChildren()
        .filter((child) => child.id)
        .map((child): CopyTarget => ({ id: child.id, key: child.id, role: "assistant", kind: "tool", col: 3 }))
    const headerIDs = new Set(walk(scroll).flatMap((node) => copyHeaders.get(node)?.() ?? []))
    let copy!: ReturnType<typeof createCopyMode>
    createRoot((cleanup) => {
      dispose = cleanup
      copy = createCopyMode({
        scroll: () => scroll,
        targets,
        session: () => session.id,
        toBottom() {},
        write: async () => {},
        canToggle: (id) => headerIDs.has(id) || id === "shell" || id === "generic",
      })
    })
    copy.prompt.enter()
    copy.prompt.jump("top")
    const seen = new Map<string, { line: number; col: number; action: boolean; text: string }>()
    const diffLines: string[] = []
    const count = targets().reduce(
      (total, target) => total + (scroll.getChildren().find((child) => child.id === target.id)?.height ?? 0),
      0,
    )
    for (let i = 0; i < count; i++) {
      const row = copy.row()
      if (row?.part === "edit" && copy.rowHasText()) {
        const copied = copy.prompt.yankLine()?.text ?? ""
        diffLines.push(copied)
        if (copied === "+after-copy") {
          const parent = scroll.getChildren().find((node) => node.id === row.id)!
          const buffer = walk(parent).find(
            (node) => "plainText" in node && String(node.plainText).includes("after-copy"),
          )!
          expect(copy.prompt.col()).toBe(buffer.x - parent.x)
        }
      }
      if (row?.part && !seen.has(row.part) && copy.rowHasText()) {
        seen.set(row.part, {
          line: row.line,
          col: copy.prompt.col(),
          action: !!copy.action(),
          text: copy.prompt.yankLine()?.text ?? "",
        })
        if (row.part !== "text:0") expect(row.id).not.toBe(`session-part:assistant:${row.part}`)
        expect(row.messageID).toBe("assistant")
      }
      copy.prompt.move("down")
    }
    expect(seen.get("reasoning:0")?.text).toContain("Plan title")
    expect(seen.get("shell")).toMatchObject({ action: true })
    expect(seen.get("shell")!.line).toBeGreaterThan(1)
    expect(seen.get("shell")!.text).toContain("copy-shell-marker")
    expect(seen.get("generic")).toMatchObject({ action: true })
    expect(seen.get("task")!.text).toContain("copy-task-marker")
    expect(diffLines).toContain("-before-copy")
    expect(diffLines).toContain("+after-copy")
    expect(seen.get("reasoning:0")!.col).toBeGreaterThan(seen.get("generic")!.col)
    dispose()
  } finally {
    dispose()
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 30000)
