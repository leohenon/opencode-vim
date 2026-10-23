import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createRoot } from "solid-js"
import { createCopyMode, type CopyTarget } from "../../../src/routes/session/copy-mode"
import { copyTarget, identifyCopyHeader, identifyCopyNode } from "../../../src/routes/session/copy-geometry"

const target: CopyTarget = { id: "group", key: "group", kind: "tool", role: "assistant", col: 3 }
const text = (plainText: string, y: number, x: number) => ({
  plainText,
  getLayout: () => ({ top: y, left: x }),
  height: 1,
  lineInfo: { lineSources: [0], lineStartCols: [0], lineWidthCols: [Bun.stringWidth(plainText)] },
  getChildren: () => [],
})
function fixture(children: any[], height = 8) {
  const child = { id: "group", y: 0, height, getChildren: () => children }
  let offset = 0
  return {
    y: 0,
    width: 80,
    height: 8,
    scrollHeight: height,
    isDestroyed: false,
    get scrollTop() {
      return offset
    },
    getChildren: () => [child],
    scrollBy(delta: number) {
      offset += delta
    },
    scrollTo(top: number) {
      offset = top
    },
  } as unknown as ScrollBoxRenderable
}

test("message copy targets retain the actual user message identity", () => {
  const user = { type: "user" as const, id: "user", text: "hello", time: { created: 0 } }
  expect(copyTarget({ type: "message", messageID: user.id }, () => user)).toMatchObject({
    messageID: "user",
    role: "user",
    kind: "user",
  })
})

test("selection references use real descendant identities in selection order", () => {
  createRoot((dispose) => {
    const nodes = [
      text("header", 0, 0),
      text("user", 1, 0),
      text("first", 2, 0),
      text("wrapped", 3, 0),
      text("second", 4, 0),
    ]
    identifyCopyNode(nodes[1], () => ({ ...target, role: "user", kind: "user", messageID: "user" }))
    for (const node of nodes.slice(2))
      identifyCopyNode(node, () => ({
        ...target,
        messageID: "assistant",
        part: node === nodes[4] ? "second" : "first",
      }))
    const scroll = fixture(nodes, 5)
    const copy = createCopyMode({
      scroll: () => scroll,
      targets: () => [target],
      session: () => "session",
      toBottom() {},
      write: async () => {},
    })
    try {
      copy.prompt.enter()
      copy.prompt.jump("top")
      copy.prompt.visual("line")
      copy.prompt.jump("bottom")
      expect(copy.prompt.selection()?.references).toEqual([
        { messageID: "user", partID: undefined, role: "user" },
        { messageID: "assistant", partID: "first", role: "assistant" },
        { messageID: "assistant", partID: "second", role: "assistant" },
      ])
    } finally {
      dispose()
    }
  })
})

test("descendants keep parent overlay coordinates but their own tool and activation identity", () => {
  createRoot((dispose) => {
    const header = text("Activity", 0, 3)
    identifyCopyHeader(header, () => "activity")
    const task = text("Task — inspect", 2, 8)
    identifyCopyNode(task, () => ({
      ...target,
      id: "task",
      key: "task",
      part: "task",
      messageID: "assistant",
      tool: "subagent",
    }))
    const command = text("$ command", 5, 9)
    identifyCopyNode(command, () => ({ ...target, id: "shell", key: "shell", part: "shell", tool: "shell" }))
    const activated: string[] = []
    const toggled: string[] = []
    const copy = createCopyMode({
      scroll: () => fixture([header, task, command]),
      targets: () => [target],
      session: () => "session",
      toBottom() {},
      write: async () => {},
      canToggle: (id) => ["activity", "shell"].includes(id),
      toggleCollapsed: (id) => {
        toggled.push(id)
        return true
      },
      activate: (row) => {
        activated.push(row.part!)
        return true
      },
    })
    copy.prompt.enter()
    copy.prompt.jump("top")
    expect(copy.action()?.text).toBe("Activity")
    expect(copy.prompt.toggleCollapsed()).toBe(true)
    copy.prompt.move("down")
    expect(copy.prompt.toggleCollapsed()).toBe(false)
    expect(copy.prompt.yankLine()).toBeNull() // Blank padding is not the preceding header.
    copy.prompt.move("down")
    expect(copy.row()).toMatchObject({ id: "group", line: 2, part: "task", messageID: "assistant", tool: "subagent" })
    expect(copy.prompt.col()).toBe(8)
    expect(copy.prompt.activate()).toBe(true)
    for (let i = 0; i < 3; i++) copy.prompt.move("down")
    expect(copy.prompt.col()).toBe(9)
    expect(copy.action()?.text).toBe("$ command")
    expect(copy.prompt.toggleCollapsed()).toBe(true)
    expect(toggled).toEqual(["activity", "shell"])
    expect(activated).toEqual(["task"])
    dispose()
  })
})

test.each(["exit", "dispose", "route"])("pending copy preparation cannot reactivate after %s", async (cancel) => {
  let resume!: () => void
  let copy!: ReturnType<typeof createCopyMode>
  let dispose!: () => void
  let session = "before"
  createRoot((cleanup) => {
    dispose = cleanup
    const scroll = fixture([text("hello", 0, 3)])
    copy = createCopyMode({
      scroll: () => scroll,
      targets: () => [target],
      session: () => session,
      toBottom() {},
      write: async () => {},
      prepare: (next) => {
        resume = next
      },
    })
    copy.prompt.enter()
  })
  if (cancel === "exit") copy.prompt.exit(false)
  if (cancel === "dispose") dispose()
  if (cancel === "route") session = "after"
  resume()
  await Bun.sleep(30)
  expect(copy.active()).toBe(false)
  expect(copy.unified()).toBe(false)
  dispose()
})

test("exit during entry compensation cannot restore an active cursor", async () => {
  let dispose!: () => void
  let copy!: ReturnType<typeof createCopyMode>
  createRoot((cleanup) => {
    dispose = cleanup
    const scroll = fixture([text("hello", 0, 3)])
    copy = createCopyMode({
      scroll: () => scroll,
      targets: () => [target],
      session: () => "session",
      toBottom() {},
      write: async () => {},
    })
    copy.prompt.enter()
    copy.prompt.exit(false)
  })
  await Bun.sleep(100)
  expect(copy.active()).toBe(false)
  expect(copy.unified()).toBe(false)
  dispose()
})

test("entry with no mounted target stops retrying and runs cleanup", async () => {
  let dispose!: () => void
  let cleanups = 0
  let reads = 0
  createRoot((cleanup) => {
    dispose = cleanup
    const scroll = fixture([])
    const copy = createCopyMode({
      scroll: () => scroll,
      targets: () => {
        reads++
        return []
      },
      session: () => "session",
      toBottom() {},
      write: async () => {},
      cleanup: () => {
        cleanups++
      },
    })
    copy.prompt.enter()
  })
  await Bun.sleep(500)
  const stopped = reads
  await Bun.sleep(80)
  expect(reads).toBe(stopped)
  expect(cleanups).toBe(1)
  dispose()
})

test("V1 quarter-viewport halfpage cursor and scroll anchoring", () => {
  createRoot((dispose) => {
    const scroll = fixture(
      Array.from({ length: 20 }, (_, i) => text(`line ${i}`, i, 3)),
      20,
    )
    const copy = createCopyMode({
      scroll: () => scroll,
      targets: () => [target],
      session: () => "session",
      toBottom() {},
      write: async () => {},
    })
    copy.prompt.enter()
    copy.prompt.jump("top")
    copy.prompt.halfPage("down")
    expect(copy.row()?.line).toBe(2)
    expect(scroll.scrollTop).toBe(2)
    copy.prompt.halfPage("up")
    expect(copy.row()?.line).toBe(0)
    expect(scroll.scrollTop).toBe(0)
    dispose()
  })
})

test("explicit movement wins over delayed entry layout compensation", async () => {
  let dispose!: () => void
  let copy!: ReturnType<typeof createCopyMode>
  createRoot((cleanup) => {
    dispose = cleanup
    const scroll = fixture(
      Array.from({ length: 20 }, (_, i) => text(`line ${i}`, i, 3)),
      20,
    )
    copy = createCopyMode({
      scroll: () => scroll,
      targets: () => [target],
      session: () => "session",
      toBottom() {},
      write: async () => {},
    })
    copy.prompt.enter()
    copy.prompt.jump("top")
    copy.prompt.move("down")
  })
  await Bun.sleep(200)
  expect(copy.row()?.line).toBe(1)
  dispose()
})
