import { expect, test } from "bun:test"
import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"

const session = {
  id: "ses_copy_layout",
  title: "Copy layout",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)]
const messages = (frame: string) => frame.match(/MESSAGE \d{3}/g) ?? []

async function fixture(history: SessionMessageInfo[], width = 80, height = 25) {
  const setup = await createAppFixture({
    width,
    height,
    config: {
      animations: false,
      vim: true,
      vim_initial_mode: "normal",
      tabs: { enabled: false },
      session: { sidebar: "hide", verbosity: "low" },
      keybinds: { "session.copy_mode": "f6" },
    },
    args: { sessionID: session.id },
    fetch(url) {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: history.toReversed(), cursor: {} })
      if (url.pathname.endsWith("/inbox")) return json({ data: [] })
    },
  })
  await setup.ready
  return setup
}

const history: SessionMessageInfo[] = Array.from({ length: 100 }, (_, index) => ({
  type: "user",
  id: `copy_layout_${index}`,
  text: `MESSAGE ${String(index).padStart(3, "0")}`,
  time: { created: index },
}))

function transcript(setup: Awaited<ReturnType<typeof fixture>>) {
  const node = walk(setup.renderer.root).find(
    (node) => node instanceof ScrollBoxRenderable && node.getChildren().some((child) => child.id === "copy_layout_99"),
  )
  if (!(node instanceof ScrollBoxRenderable)) throw new Error("Missing transcript scrollbox")
  return node
}

async function enter(setup: Awaited<ReturnType<typeof fixture>>) {
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("COPY"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
}

test("copy preparation preserves the same visible messages when mounting the complete transcript", async () => {
  await using setup = await fixture(history)
  await waitForHighlightedFrame(setup, (frame) => frame.includes("MESSAGE 099"))
  const scroll = transcript(setup)
  scroll.scrollBy(-8)
  await setup.waitForVisualIdle({ quietFrames: 3 })
  const before = messages(setup.captureCharFrame())
  expect(before.length).toBeGreaterThan(0)
  await enter(setup)
  expect(messages(setup.captureCharFrame())).toEqual(before)
})

test("copy mode keeps old rows mounted after visiting the bottom", async () => {
  await using setup = await fixture(history)
  await waitForHighlightedFrame(setup, (frame) => frame.includes("MESSAGE 099"))
  const scroll = transcript(setup)
  await enter(setup)
  setup.mockInput.pressKey("g", { shift: true })
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(scroll.getChildren().some((node) => node.id === "copy_layout_0")).toBe(true)
  setup.mockInput.pressKey("g")
  setup.mockInput.pressKey("g")
  await setup.waitForFrame((frame) => frame.includes("MESSAGE 000"))
})

test("copy preserve-scroll exit does not change the visible messages after window cleanup", async () => {
  await using setup = await fixture(history)
  await waitForHighlightedFrame(setup, (frame) => frame.includes("MESSAGE 099"))
  await enter(setup)
  setup.mockInput.pressKey("g", { shift: true })
  for (let index = 0; index < 90; index++) setup.mockInput.pressKey("k")
  await setup.waitForVisualIdle({ quietFrames: 3 })
  const before = messages(setup.captureCharFrame())
  expect(before.length).toBeGreaterThan(0)
  setup.mockInput.pressKey("w", { ctrl: true })
  setup.mockInput.pressKey("j", { ctrl: true })
  await setup.waitForFrame((frame) => !frame.includes("COPY"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(messages(setup.captureCharFrame())).toEqual(before)
})

function copyCursor(setup: Awaited<ReturnType<typeof fixture>>) {
  return walk(setup.renderer.root).find(
    (node) =>
      node.height === 1 &&
      node.width <= 2 &&
      !!node.parent &&
      (node.parent.id.startsWith("session-") || node.parent.id.startsWith("copy_resize_")) &&
      node.getChildren().some((child) => "plainText" in child && String(child.plainText).length > 0),
  )
}

const wrappedHistory: SessionMessageInfo[] = [
  { type: "user", id: "copy_resize_user", text: "Copy resize", time: { created: 0 } },
  {
    type: "assistant",
    id: "copy_resize_assistant",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    time: { created: 1, completed: 2 },
    finish: "stop",
    content: [{ type: "text", text: "abcdefghij".repeat(20) + "\nFINAL MARKER" }],
  },
]

test("resize keeps the rendered selection and yanked logical text aligned", async () => {
  await using setup = await fixture(wrappedHistory, 100, 40)
  await waitForHighlightedFrame(setup, (frame) => frame.includes("FINAL MARKER"))
  await enter(setup)
  setup.mockInput.pressKey("/")
  await setup.mockInput.typeText("FINAL MARKER")
  setup.mockInput.pressEnter()
  setup.mockInput.pressKey("v")
  for (let index = 0; index < "FINAL MARKER".length - 1; index++) setup.mockInput.pressKey("l")
  await setup.waitForVisualIdle({ quietFrames: 2 })
  expect(copyCursor(setup)).toBeDefined()
  setup.renderer.resize(50, 40)
  await setup.waitForFrame((frame) => {
    const line = frame.split("\n").findIndex((line) => line.includes("FINAL MARKER"))
    return line >= 0 && copyCursor(setup)?.y === line
  })
  setup.mockInput.pressKey("y")
  setup.mockInput.pressKey("w", { ctrl: true })
  setup.mockInput.pressKey("j", { ctrl: true })
  setup.mockInput.pressKey("p")
  await setup.waitForFrame((frame) => frame.split("FINAL MARKER").length >= 3)
})

// Cell painting only; Unicode word motions/text objects remain unsupported.
test("copy cursor does not clip an already-rendered two-cell character", async () => {
  const history = structuredClone(wrappedHistory)
  const assistant = history[1]!
  if (assistant.type !== "assistant") throw new Error("Expected assistant")
  assistant.content = [{ type: "text", text: "A界B" }]
  await using setup = await fixture(history)
  await waitForHighlightedFrame(setup, (frame) => frame.includes("A界B"))
  await enter(setup)
  setup.mockInput.pressKey("/")
  await setup.mockInput.typeText("A界B")
  setup.mockInput.pressEnter()
  setup.mockInput.pressKey("l")
  await setup.waitForVisualIdle({ quietFrames: 2 })
  expect(setup.captureCharFrame()).toContain("A界B")
  expect(
    copyCursor(setup)
      ?.getChildren()
      .some((node) => "plainText" in node && node.plainText === "界"),
  ).toBe(true)
})
