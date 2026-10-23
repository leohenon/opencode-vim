import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createAppFixture } from "../../fixture/app"
import { directory, json } from "../../fixture/tui-client"

async function promptFixture() {
  const app = await createAppFixture({
    config: { animations: false, vim: true, vim_initial_mode: "normal", tabs: { mode: "off" } },
  })
  await app.ready
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const textarea = app.renderer.currentFocusedEditor as TextareaRenderable
  app.mockInput.pressKey("ESCAPE")
  await app.renderOnce()
  return { app, textarea }
}

function cell(app: Awaited<ReturnType<typeof createAppFixture>>, x: number, y: number) {
  let column = 0
  return app.captureSpans().lines[y]?.spans.find((span) => {
    column += span.text.length
    return column > x
  })
}

test("production prompt repeats counted line deletion", async () => {
  const { app, textarea } = await promptFixture()
  try {
    textarea.setText("one\ntwo\nthree\nfour\nfive\nsix")
    textarea.cursorOffset = 0
    await app.mockInput.typeText("2dd")
    expect(textarea.plainText).toBe("three\nfour\nfive\nsix")
    await app.mockInput.typeText(".")
    expect(textarea.plainText).toBe("five\nsix")
  } finally {
    await app[Symbol.asyncDispose]()
  }
})

test.each(["Vjj", "vjj"])(
  "production prompt paints a focused block cursor and selected empty rows (%s)",
  async (selection) => {
    const { app, textarea } = await promptFixture()
    try {
      textarea.setText("one\n\nthree")
      textarea.cursorOffset = 0
      await app.renderOnce()
      expect(textarea.showCursor).toBe(false)
      expect(cell(app, textarea.x, textarea.y)?.bg.toInts()).toEqual(textarea.textColor.toInts())
      expect(cell(app, textarea.x, textarea.y)?.fg.toInts()).not.toEqual(textarea.textColor.toInts())
      textarea.blur()
      await app.renderOnce()
      expect(cell(app, textarea.x, textarea.y)?.bg.toInts()).not.toEqual(textarea.textColor.toInts())
      textarea.focus()
      await app.mockInput.typeText(selection)
      await app.renderOnce()
      expect(cell(app, textarea.x, textarea.y + 1)?.bg.toInts()).toEqual(textarea.selectionBg!.toInts())
      expect(cell(app, textarea.x, textarea.y + 1)?.fg.toInts()).toEqual(textarea.selectionFg!.toInts())
      app.mockInput.pressKey("ESCAPE")
      await app.mockInput.typeText("i")
      await app.renderOnce()
      expect(textarea.showCursor).toBe(true)
    } finally {
      await app[Symbol.asyncDispose]()
    }
  },
)

test.each(["d", "2", "f"])("production prompt clears pending %s when a dialog takes focus", async (pending) => {
  const { app, textarea } = await promptFixture()
  try {
    textarea.setText("one two three")
    textarea.cursorOffset = 0
    await app.mockInput.typeText(pending)
    app.mockInput.pressKey("p", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("Commands"))
    expect(textarea.focused).toBe(false)
    app.mockInput.pressKey("ESCAPE")
    app.mockInput.pressKey("ESCAPE")
    await app.waitFor(() => textarea.focused)
    await app.mockInput.typeText("w")
    expect(textarea.plainText).toBe("one two three")
    expect(textarea.cursorOffset).toBe(4)
  } finally {
    await app[Symbol.asyncDispose]()
  }
})

test("running-session Escape normalizes insert mode before arming interruption", async () => {
  const session = {
    id: "ses_prompt_vim",
    title: "Vim interrupt",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using app = await createAppFixture({
    args: { sessionID: session.id },
    config: { animations: false, vim: true, vim_initial_mode: "normal", tabs: { mode: "off" } },
    fetch(url) {
      if (url.pathname === "/api/session/active") return json({ data: { [session.id]: { type: "running" } } })
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
    },
  })
  await app.ready
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const textarea = app.renderer.currentFocusedEditor as TextareaRenderable
  app.mockInput.pressKey("ESCAPE")
  await app.mockInput.typeText("ihello")
  await app.waitForFrame((frame) => frame.includes("INSERT"))
  app.mockInput.pressKey("ESCAPE")
  const normal = await app.waitForFrame((frame) => !frame.includes("INSERT"))
  expect(normal).not.toContain("again")
  expect(textarea.plainText).toBe("hello")
  app.mockInput.pressKey("ESCAPE")
  await app.waitForFrame((frame) => frame.includes("again"))
  // Interrupt mode normalization cancels the open edit rather than leaving an unfinished undo session.
  await app.mockInput.typeText("u")
  expect(textarea.plainText).toBe("hello")
})

test("production prompt retains dot-repeat for text edits", async () => {
  const { app, textarea } = await promptFixture()
  try {
    textarea.setText("alpha beta gamma delta")
    textarea.cursorOffset = 0
    await app.mockInput.typeText("x")
    expect(textarea.plainText).toBe("lpha beta gamma delta")
    await app.mockInput.typeText(".")
    expect(textarea.plainText).toBe("pha beta gamma delta")
    await app.mockInput.typeText("i#")
    app.mockInput.pressKey("ESCAPE")
    await app.waitForFrame((frame) => frame.includes("#pha") && !frame.includes("INSERT"))
    await app.mockInput.typeText("l.")
    expect(textarea.plainText).toBe("##pha beta gamma delta")
  } finally {
    await app[Symbol.asyncDispose]()
  }
})
