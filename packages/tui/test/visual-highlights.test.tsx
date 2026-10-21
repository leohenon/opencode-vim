import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { getOpenCodeTheme } from "../src/theme"
import { migrateV1, resolveThemeDocument } from "@opencode/theme/tui"
import type { ThemeV1Json } from "@opencode/theme/tui/v1"
import { directory, json } from "./fixture/tui-client"

type Fixture = Awaited<ReturnType<typeof createAppFixture>>
type Frame = ReturnType<Fixture["captureSpans"]>
const themes = [
  { name: "vesper", mode: "dark" },
  { name: "vesper", mode: "light" },
  { name: "opencode", mode: "dark" },
  { name: "opencode", mode: "light" },
] as const
const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)]

function pixel(frame: Frame, x: number, y: number) {
  let left = 0
  for (const span of frame.lines[y]?.spans ?? []) {
    const right = left + Bun.stringWidth(span.text)
    if (x >= left && x < right) return { fg: span.fg.toInts(), bg: span.bg.toInts() }
    left = right
  }
  throw new Error(`No rendered cell at ${x},${y}`)
}

async function selectionColors(theme: (typeof themes)[number]) {
  if (theme.name === "opencode") return resolveThemeDocument(getOpenCodeTheme(), theme.mode)
  const source: ThemeV1Json = await Bun.file(new URL(`../src/theme/assets/${theme.name}.json`, import.meta.url)).json()
  return resolveThemeDocument(migrateV1(source), theme.mode)
}

function expectVisible(
  normal: ReturnType<typeof pixel>,
  selected: ReturnType<typeof pixel>,
  expected?: ReturnType<typeof pixel>,
) {
  // Compare actual composed terminal colors, not the configured selection property against itself.
  expect(selected.bg).not.toEqual(normal.bg)
  expect(selected.fg).not.toEqual(selected.bg)
  if (expected) {
    expect(expected.bg[3]).toBe(255)
    expect(selected).toEqual(expected)
  }
}

async function press(setup: Fixture, key: string) {
  setup.mockInput.pressKey(key)
  await setup.waitForVisualIdle({ quietFrames: 3 })
}

const session = {
  id: "ses_visual_highlights",
  title: "Selection fixture",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

async function fixture(theme: (typeof themes)[number], copy = false) {
  const setup = await createAppFixture({
    height: 38,
    args: copy ? { sessionID: session.id } : {},
    config: {
      animations: false,
      vim: true,
      vim_initial_mode: "normal",
      theme,
      tabs: { mode: "off" },
      session: { sidebar: "hide" },
      keybinds: { "session.copy_mode": "f6" },
    },
    fetch: copy
      ? (url) => {
          if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
          if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
          if (url.pathname === `/api/session/${session.id}/message`)
            return json({
              data: [
                {
                  type: "assistant",
                  id: "visual_assistant",
                  agent: "build",
                  model: { providerID: "fixture", id: "fixture" },
                  time: { created: 1, completed: 2 },
                  finish: "stop",
                  content: [{ type: "text", text: "marker answer" }],
                },
                { type: "user", id: "visual_user", text: "marker question", time: { created: 0 } },
              ],
              cursor: {},
            })
          if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
          return undefined
        }
      : undefined,
  })
  await setup.ready
  if (copy) await setup.waitForFrame((frame) => frame.includes("marker answer"))
  await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const textarea = setup.renderer.currentFocusedEditor
  if (!(textarea instanceof TextareaRenderable)) throw new Error("Expected a focused composer")
  setup.mockInput.pressEscape()
  await setup.renderOnce()
  return { setup, textarea }
}

function cursor(setup: Fixture) {
  const node = walk(setup.renderer.root).find(
    (node) =>
      node.width === 1 &&
      node.height === 1 &&
      node.getChildren().some((child) => "plainText" in child) &&
      (node.parent?.id === "visual_user" || node.parent?.id.startsWith("session-")),
  )
  if (!node) throw new Error("Expected a rendered copy cursor")
  return node
}

for (const theme of themes) {
  test(`prompt visual selection is visible with ${theme.name} ${theme.mode}`, async () => {
    const colors = await selectionColors(theme)
    const { setup, textarea } = await fixture(theme)
    try {
      textarea.setText("marker words")
      textarea.cursorOffset = 4
      await setup.renderOnce()
      const normal = pixel(setup.captureSpans(), textarea.x, textarea.y)
      textarea.cursorOffset = 0
      await setup.mockInput.typeText("vll")
      await setup.renderOnce()
      expect(textarea.editorView.getSelection()).toMatchObject({ start: 0, end: 3 })
      expectVisible(normal, pixel(setup.captureSpans(), textarea.x, textarea.y), {
        bg: colors.background.selection.base.toInts(),
        fg: colors.text.selection.base.toInts(),
      })
    } finally {
      await setup[Symbol.asyncDispose]()
    }
  })

  for (const mode of ["char", "line", "block"] as const) {
    test(`copy ${mode} selection is visible with ${theme.name} ${theme.mode}`, async () => {
      const colors = await selectionColors(theme)
      const { setup } = await fixture(theme, true)
      try {
        await press(setup, "F6")
        await setup.mockInput.typeText("ggj")
        await setup.waitForVisualIdle({ quietFrames: 3 })
        const anchor = { x: cursor(setup).x, y: cursor(setup).y }
        await press(setup, "l")
        const normal = pixel(setup.captureSpans(), anchor.x, anchor.y)
        await press(setup, "h")
        if (mode === "block") setup.mockInput.pressKey("v", { ctrl: true })
        else setup.mockInput.pressKey("v", { shift: mode === "line" })
        await setup.mockInput.typeText("ll")
        await setup.waitForVisualIdle({ quietFrames: 3 })
        expect(cursor(setup).x).toBe(anchor.x + 2)
        expectVisible(normal, pixel(setup.captureSpans(), anchor.x, anchor.y), {
          bg: colors.background.selection.base.toInts(),
          fg: colors.text.selection.base.toInts(),
        })
      } finally {
        await setup[Symbol.asyncDispose]()
      }
    })
  }

  test(`copy search highlights current and other matches with ${theme.name} ${theme.mode}`, async () => {
    const colors = await selectionColors(theme)
    const { setup } = await fixture(theme, true)
    try {
      await press(setup, "F6")
      await setup.mockInput.typeText("ggj")
      await setup.waitForVisualIdle({ quietFrames: 3 })
      const normal = setup.captureSpans()
      await setup.mockInput.typeText("/marker")
      setup.mockInput.pressEnter()
      await setup.waitForVisualIdle({ quietFrames: 3 })
      const matches = walk(setup.renderer.root).filter((node) => "plainText" in node && node.plainText === "marker")
      expect(matches).toHaveLength(2)
      const selected = setup.captureSpans()
      const rendered = matches.map((node) => pixel(selected, node.x + 1, node.y))
      for (const node of matches) {
        expectVisible(pixel(normal, node.x + 1, node.y), pixel(selected, node.x + 1, node.y))
      }
      expect(rendered).toContainEqual({
        bg: colors.background.selection.current.toInts(),
        fg: colors.text.selection.current.toInts(),
      })
      expect(rendered).toContainEqual({
        bg: colors.background.selection.search.toInts(),
        fg: colors.text.selection.search.toInts(),
      })
    } finally {
      await setup[Symbol.asyncDispose]()
    }
  })
}
