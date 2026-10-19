import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createTestRenderer } from "@opentui/core/testing"
import { TextareaRenderable } from "@opentui/core"
import { createVimHandler, type VimEvent } from "../src/component/vim/vim-handler"
import {
  moveVisualFirstNonWhitespace,
  moveVisualLineBeginning,
  moveVisualLineDown,
  moveVisualLineEnd,
  moveVisualLineUp,
} from "../src/component/vim/vim-motions"
import { createVimState } from "../src/component/vim/vim-state"

const WRAPPED = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10"

function createEvent(name: string): VimEvent {
  return {
    name,
    preventDefault() {},
  }
}

async function createWrappedTextarea(text: string) {
  const setup = await createTestRenderer({ width: 20, height: 12, useThread: false })
  const textarea = new TextareaRenderable(setup.renderer as any, { width: 20, height: 10 })
  setup.renderer.root.add(textarea)
  textarea.setText(text)
  return {
    textarea,
    [Symbol.dispose]() {
      setup.renderer.destroy()
    },
  }
}

async function createWrappedHandler(
  text: string,
  options: { vimLineMotions?: "logical" | "display_vertical" | "display" } = {},
) {
  const setup = await createWrappedTextarea(text)
  let disposeRoot!: () => void
  const state = createRoot((dispose) => {
    disposeRoot = dispose
    return createVimState({ enabled: () => true, initial: () => "normal" })
  })
  const handler = createVimHandler({
    enabled: () => true,
    state,
    textarea: () => setup.textarea,
    submit() {},
    scroll() {},
    jump() {},
    vimLineMotions: () => options.vimLineMotions,
  })
  return {
    textarea: setup.textarea,
    state,
    handler,
    [Symbol.dispose]() {
      disposeRoot()
      setup[Symbol.dispose]()
    },
  }
}

describe("visual line motions (gj/gk)", () => {
  test("single logical line wraps into multiple display rows", async () => {
    using ctx = await createWrappedTextarea(WRAPPED)
    expect(WRAPPED.includes("\n")).toBe(false)
    expect(ctx.textarea.virtualLineCount).toBeGreaterThan(1)
  })

  test("moveVisualLineDown moves one display row inside a wrapped line", async () => {
    using ctx = await createWrappedTextarea(WRAPPED)
    ctx.textarea.cursorOffset = 0

    const before = ctx.textarea.editorView.getVisualCursor()
    moveVisualLineDown(ctx.textarea)
    const after = ctx.textarea.editorView.getVisualCursor()

    expect(after.visualRow).toBe(before.visualRow + 1)
    expect(after.logicalRow).toBe(0)
    expect(ctx.textarea.cursorOffset).toBeGreaterThan(0)
    expect(ctx.textarea.cursorOffset).toBeLessThan(WRAPPED.length)
  })

  test("moveVisualLineUp returns to the previous display row", async () => {
    using ctx = await createWrappedTextarea(WRAPPED)
    ctx.textarea.cursorOffset = 0

    moveVisualLineDown(ctx.textarea)
    const mid = ctx.textarea.cursorOffset
    expect(mid).toBeGreaterThan(0)

    moveVisualLineUp(ctx.textarea)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("preserves goal column across shorter display rows", async () => {
    using ctx = await createWrappedTextarea("aaaaaa bbbbbb cccc\ndd\neeeeee ffffff gggg")
    ctx.textarea.cursorOffset = 10

    moveVisualLineDown(ctx.textarea)
    expect(ctx.textarea.editorView.getVisualCursor().visualCol).toBe(2)

    moveVisualLineDown(ctx.textarea)
    expect(ctx.textarea.editorView.getVisualCursor().visualCol).toBe(10)
  })

  test("stays put at the last display row", async () => {
    using ctx = await createWrappedTextarea(WRAPPED)
    ctx.textarea.cursorOffset = WRAPPED.length - 1
    const before = ctx.textarea.editorView.getVisualCursor().visualRow

    moveVisualLineDown(ctx.textarea)
    expect(ctx.textarea.editorView.getVisualCursor().visualRow).toBe(before)
  })

  test("stays put at the first display row", async () => {
    using ctx = await createWrappedTextarea(WRAPPED)
    ctx.textarea.cursorOffset = 3

    moveVisualLineUp(ctx.textarea)
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("crosses logical line boundaries like a display row", async () => {
    using ctx = await createWrappedTextarea("abc\ndef")
    ctx.textarea.cursorOffset = 1

    moveVisualLineDown(ctx.textarea)
    expect(ctx.textarea.cursorOffset).toBe(5)
  })

  test("repeated gj preserves visual column across short rows", async () => {
    using ctx = await createWrappedHandler("aaaaaa bbbbbb cccc\ndd\neeeeee ffffff gggg")
    ctx.textarea.cursorOffset = 10

    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("j"))
    expect(ctx.textarea.editorView.getVisualCursor().visualCol).toBe(1)

    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("j"))
    expect(ctx.textarea.editorView.getVisualCursor().visualCol).toBe(10)
  })

  test("vim_line_motions display_vertical maps j and k to display rows", async () => {
    using ctx = await createWrappedHandler(WRAPPED, { vimLineMotions: "display_vertical" })

    ctx.handler.handleKey(createEvent("j"))
    expect(ctx.textarea.editorView.getVisualCursor().visualRow).toBe(1)
    expect(ctx.textarea.editorView.getVisualCursor().logicalRow).toBe(0)

    ctx.handler.handleKey(createEvent("k"))
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("vim_line_motions display supports counts in visual mode", async () => {
    using ctx = await createWrappedHandler("A".repeat(100), { vimLineMotions: "display" })

    ctx.handler.handleKey(createEvent("v"))
    ctx.handler.handleKey(createEvent("3"))
    ctx.handler.handleKey(createEvent("j"))

    expect(ctx.textarea.editorView.getVisualCursor().visualRow).toBe(3)
    expect(ctx.textarea.cursorOffset).toBe(60)
    expect(ctx.state.count()).toBe("")
  })

  test("vim_line_motions display_vertical applies to vertical operators", async () => {
    using ctx = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC", {
      vimLineMotions: "display_vertical",
    })

    ctx.handler.handleKey(createEvent("d"))
    ctx.handler.handleKey(createEvent("j"))

    expect(ctx.textarea.plainText).toBe("BBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "AAAAAAAAAAAAAAAAAAAA", linewise: false })
  })

  test("vim_line_motions display_vertical keeps line boundaries logical", async () => {
    using ctx = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC", {
      vimLineMotions: "display_vertical",
    })
    ctx.textarea.cursorOffset = 24

    ctx.handler.handleKey(createEvent("0"))
    expect(ctx.textarea.cursorOffset).toBe(0)

    ctx.textarea.cursorOffset = 24
    ctx.handler.handleKey(createEvent("$"))
    expect(ctx.textarea.cursorOffset).toBe(59)
  })

  test("vim_line_motions display_vertical transfers $ stickiness to j and k", async () => {
    using down = await createWrappedHandler(`short\n${"A".repeat(30)}`, { vimLineMotions: "display_vertical" })
    down.handler.handleKey(createEvent("$"))
    down.handler.handleKey(createEvent("j"))
    expect(down.textarea.cursorOffset).toBe(25)

    using up = await createWrappedHandler(`short\n${"A".repeat(30)}`, { vimLineMotions: "display_vertical" })
    up.textarea.cursorOffset = 30
    up.handler.handleKey(createEvent("$"))
    up.handler.handleKey(createEvent("k"))
    expect(up.textarea.cursorOffset).toBe(25)
  })

  test("vim_line_motions display_vertical preserves $ stickiness through gj and gk", async () => {
    using down = await createWrappedHandler(`short\n${"A".repeat(30)}`, { vimLineMotions: "display_vertical" })
    down.handler.handleKey(createEvent("$"))
    down.handler.handleKey(createEvent("g"))
    down.handler.handleKey(createEvent("j"))
    expect(down.textarea.cursorOffset).toBe(25)

    using up = await createWrappedHandler(`short\n${"A".repeat(30)}`, { vimLineMotions: "display_vertical" })
    up.textarea.cursorOffset = 30
    up.handler.handleKey(createEvent("$"))
    up.handler.handleKey(createEvent("g"))
    up.handler.handleKey(createEvent("k"))
    expect(up.textarea.cursorOffset).toBe(25)
  })

  test("vim_line_motions display maps line boundaries to display rows", async () => {
    using ctx = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC", {
      vimLineMotions: "display",
    })
    ctx.textarea.cursorOffset = 24

    ctx.handler.handleKey(createEvent("0"))
    expect(ctx.textarea.cursorOffset).toBe(20)

    ctx.textarea.cursorOffset = 24
    ctx.handler.handleKey(createEvent("$"))
    expect(ctx.textarea.cursorOffset).toBe(39)
  })

  test("vim_line_motions display keeps $ sticky across display rows", async () => {
    using ctx = await createWrappedHandler(`short\n${"A".repeat(30)}`, { vimLineMotions: "display" })

    ctx.handler.handleKey(createEvent("$"))
    expect(ctx.textarea.cursorOffset).toBe(4)

    ctx.handler.handleKey(createEvent("j"))
    expect(ctx.textarea.cursorOffset).toBe(25)

    ctx.handler.handleKey(createEvent("j"))
    expect(ctx.textarea.cursorOffset).toBe(35)

    ctx.handler.handleKey(createEvent("k"))
    expect(ctx.textarea.cursorOffset).toBe(25)
  })

  test("g$ keeps display-row end sticky for gj", async () => {
    using ctx = await createWrappedHandler(`short\n${"A".repeat(30)}`)

    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("$"))
    expect(ctx.textarea.cursorOffset).toBe(4)

    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("j"))
    expect(ctx.textarea.cursorOffset).toBe(25)
  })

  test("vim_line_motions display maps line-boundary operators to display rows", async () => {
    using ctx = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBB", { vimLineMotions: "display" })
    ctx.textarea.cursorOffset = 24

    ctx.handler.handleKey(createEvent("d"))
    ctx.handler.handleKey(createEvent("0"))

    expect(ctx.textarea.plainText).toBe("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBB")
    expect(ctx.textarea.cursorOffset).toBe(20)
    expect(ctx.state.register()).toEqual({ text: "BBBB", linewise: false })
  })

  test("dgj deletes one wrapped display row charwise", async () => {
    using ctx = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC")

    ctx.handler.handleKey(createEvent("d"))
    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("j"))

    expect(ctx.textarea.plainText).toBe("BBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "AAAAAAAAAAAAAAAAAAAA", linewise: false })
  })

  test("dgk deletes one wrapped display row charwise backward", async () => {
    using ctx = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC")
    ctx.textarea.cursorOffset = 40

    ctx.handler.handleKey(createEvent("d"))
    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("k"))

    expect(ctx.textarea.plainText).toBe("AAAAAAAAAAAAAAAAAAAACCCCCCCCCCCCCCCCCCCC")
    expect(ctx.textarea.cursorOffset).toBe(20)
    expect(ctx.state.register()).toEqual({ text: "BBBBBBBBBBBBBBBBBBBB", linewise: false })
  })

  test("ygk yanks one wrapped display row charwise", async () => {
    using ctx = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC")
    ctx.textarea.cursorOffset = 40

    ctx.handler.handleKey(createEvent("y"))
    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("k"))

    expect(ctx.textarea.plainText).toBe("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC")
    expect(ctx.textarea.cursorOffset).toBe(20)
    expect(ctx.state.register()).toEqual({ text: "BBBBBBBBBBBBBBBBBBBB", linewise: false })
  })

  test("cgj changes one wrapped display row charwise", async () => {
    using ctx = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC")

    ctx.handler.handleKey(createEvent("c"))
    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("j"))

    expect(ctx.textarea.plainText).toBe("BBBBBBBBBBBBBBBBBBBBCCCCCCCCCCCCCCCCCCCC")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "AAAAAAAAAAAAAAAAAAAA", linewise: false })
  })

  test("display-line horizontal helpers stay on the current wrapped row", async () => {
    using ctx = await createWrappedTextarea("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBB")
    ctx.textarea.cursorOffset = 24

    moveVisualLineBeginning(ctx.textarea)
    expect(ctx.textarea.cursorOffset).toBe(20)
    expect(ctx.textarea.editorView.getVisualCursor().visualCol).toBe(0)

    moveVisualLineEnd(ctx.textarea)
    expect(ctx.textarea.cursorOffset).toBe(39)
    expect(ctx.textarea.editorView.getVisualCursor().visualCol).toBe(19)
  })

  test("display-line first non-whitespace skips blanks on the current wrapped row", async () => {
    using ctx = await createWrappedTextarea("  AAAAAAAAAAAAAAAAAA")
    ctx.textarea.cursorOffset = 1

    moveVisualFirstNonWhitespace(ctx.textarea)
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("g0, g^, and g$ use wrapped display rows", async () => {
    using ctx = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBB")

    ctx.textarea.cursorOffset = 24
    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("0"))
    expect(ctx.textarea.cursorOffset).toBe(20)

    ctx.textarea.cursorOffset = 24
    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("$"))
    expect(ctx.textarea.cursorOffset).toBe(39)

    using indented = await createWrappedHandler("  AAAAAAAAAAAAAAAAAA")
    indented.textarea.cursorOffset = 1
    indented.handler.handleKey(createEvent("g"))
    indented.handler.handleKey(createEvent("^"))
    expect(indented.textarea.cursorOffset).toBe(2)
  })

  test("display-line horizontal operators use wrapped rows", async () => {
    using ctx = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBB")
    ctx.textarea.cursorOffset = 24

    ctx.handler.handleKey(createEvent("d"))
    ctx.handler.handleKey(createEvent("g"))
    ctx.handler.handleKey(createEvent("0"))

    expect(ctx.textarea.plainText).toBe("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBB")
    expect(ctx.textarea.cursorOffset).toBe(20)
    expect(ctx.state.register()).toEqual({ text: "BBBB", linewise: false })

    using yank = await createWrappedHandler("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBB")
    yank.textarea.cursorOffset = 24
    yank.handler.handleKey(createEvent("y"))
    yank.handler.handleKey(createEvent("g"))
    yank.handler.handleKey(createEvent("$"))

    expect(yank.textarea.plainText).toBe("AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBB")
    expect(yank.textarea.cursorOffset).toBe(24)
    expect(yank.state.register()).toEqual({ text: "BBBBBBBBBBBBBBBB", linewise: false })
  })
})
