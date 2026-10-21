import { describe, expect, test } from "bun:test"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { createCopyMode } from "../../../src/routes/session/copy-mode"
import { createRoot, createSignal } from "solid-js"
import { Skill } from "@opencode/schema/skill"
import type { PromptInfo } from "../../../src/prompt/history"
import { createVimHandler } from "../../../src/component/vim/vim-handler"
import { createVimState } from "../../../src/component/vim/vim-state"
import type { VimScroll } from "../../../src/component/vim/vim-scroll"
import { vimScroll } from "../../../src/component/vim/vim-scroll"
import type { VimJump } from "../../../src/component/vim/vim-motion-jump"
import {
  copyMatchingBracket,
  copyNextParagraph,
  copyPreviousParagraph,
  copyWordEnd,
  copyWordNext,
  copyWordPrev,
  deleteSelection,
} from "../../../src/component/vim/vim-motions"

function rowColToOffset(text: string, row: number, col: number) {
  let index = 0
  let current = 0
  while (current < row) {
    const next = text.indexOf("\n", index)
    if (next === -1) return text.length
    index = next + 1
    current++
  }
  return Math.min(index + col, text.length)
}

function offsetToRowCol(text: string, offset: number) {
  let row = 0
  let col = 0
  let index = 0
  while (index < offset && index < text.length) {
    if (text[index] === "\n") {
      row++
      col = 0
      index++
      continue
    }
    col++
    index++
  }
  return { row, col }
}

function createTextarea(text: string, opts?: { strict?: boolean }) {
  let sel: { start: number; end: number } | null = null
  let anchor: number | null = null
  const textarea = {
    plainText: text,
    cursorOffset: 0,
    get logicalCursor() {
      return offsetToRowCol(textarea.plainText, textarea.cursorOffset)
    },
    setText(value: string) {
      textarea.plainText = value
      textarea.cursorOffset = Math.min(textarea.cursorOffset, value.length)
    },
    insertText(value: string) {
      const head = textarea.plainText.slice(0, textarea.cursorOffset)
      const tail = textarea.plainText.slice(textarea.cursorOffset)
      textarea.plainText = head + value + tail
      textarea.cursorOffset += value.length
    },
    deleteRange(startRow: number, startCol: number, endRow: number, endCol: number) {
      const start = rowColToOffset(textarea.plainText, startRow, startCol)
      const end = rowColToOffset(textarea.plainText, endRow, endCol)
      textarea.plainText = textarea.plainText.slice(0, start) + textarea.plainText.slice(end)
      textarea.cursorOffset = start
    },
    updateSelectionForMovement(shift: boolean, before: boolean) {
      if (!shift) {
        anchor = null
        sel = null
        return
      }
      if (before) {
        anchor = textarea.cursorOffset
        return
      }
      if (anchor === null) return
      sel = { start: Math.min(anchor, textarea.cursorOffset), end: Math.max(anchor, textarea.cursorOffset) }
    },
    editorView: {
      setSelection(start: number, end: number) {
        sel = { start, end }
      },
      resetSelection() {
        sel = null
        anchor = null
      },
      resetLocalSelection() {},
      getSelection() {
        return sel
      },
      hasSelection() {
        return sel !== null
      },
      getSelectedText() {
        if (!sel) return ""
        return textarea.plainText.slice(sel.start, sel.end)
      },
      deleteSelectedText() {
        if (!sel) return
        textarea.plainText = textarea.plainText.slice(0, sel.start) + textarea.plainText.slice(sel.end)
        textarea.cursorOffset = sel.start
        sel = null
      },
    },
    editBuffer: {
      offsetToPosition(offset: number) {
        if (opts?.strict && offset > textarea.plainText.length) return null
        return offsetToRowCol(textarea.plainText, offset)
      },
    },
  }
  return textarea as unknown as TextareaRenderable
}

function createEvent(
  name: string,
  options?: { shift?: boolean; ctrl?: boolean; meta?: boolean; super?: boolean; sequence?: string; raw?: string },
) {
  let prevented = false
  return {
    event: {
      name,
      shift: options?.shift,
      ctrl: options?.ctrl,
      meta: options?.meta,
      super: options?.super,
      sequence: options?.sequence,
      raw: options?.raw,
      preventDefault() {
        prevented = true
      },
    },
    prevented: () => prevented,
  }
}

function createHandler(
  text: string,
  options?: {
    enabled?: boolean
    mode?: "normal" | "insert" | "replace" | "visual" | "visual-line" | "copy"
    strict?: boolean
    submit?: () => void
    commandPalette?: () => void
    autocomplete?: () => false | "@" | "/"
    flash?: (span: { start: number; end: number }) => void
    copy?: {
      text?: string
      texts?: string[]
      col?: number
      idx?: number
      rows?: Array<{ col: number }>
      isVisual?: boolean
      toggleCollapsed?: () => boolean
      activate?: () => boolean
    }
    register?: {
      get?: () => { text: string; linewise: boolean } | null
      set?: (register: { text: string; linewise: boolean } | null, notify?: boolean) => void
    }
    pasteOverSelection?: () => boolean
    data?: unknown
    snapshotDataEqual?: (before: unknown, after: unknown) => boolean
    langmap?: Record<string, string>
    vimLineMotions?: "logical" | "display_vertical" | "display"
    copySearchAvailable?: boolean
    vimEscapeSequence?: string
  },
) {
  const textarea = createTextarea(text, { strict: options?.strict })
  const [enabled] = createSignal(options?.enabled ?? true)
  const state = createRoot(() => createVimState({ enabled, initial: () => options?.mode ?? "normal" }))
  const [copyVisual, setCopyVisual] = createSignal<undefined | "char" | "line" | "block">(
    options?.copy?.isVisual ? "char" : undefined,
  )
  const [meta, setMeta] = createSignal(options?.data)
  const [copyCol, setCopyCol] = createSignal(options?.copy?.col ?? 0)
  const [copyIdx, setCopyIdx] = createSignal(options?.copy?.idx ?? 0)
  const copyRows = options?.copy?.rows
  const scrollCalls: VimScroll[] = []
  const jumpCalls: VimJump[] = []
  const navigateCalls: Array<"up" | "down"> = []
  const commandPaletteCalls: true[] = []
  const copyMoves: Array<"up" | "down" | "left" | "right"> = []
  const copyHalfPages: Array<"up" | "down"> = []
  const copyJumps: Array<VimJump | "high" | "middle" | "low"> = []
  const copyVisualCalls: Array<"char" | "line" | "block"> = []
  const copyScrollCalls: Array<"center" | "top" | "bottom"> = []
  const copySearchCalls: Array<"forward" | "backward"> = []
  const copySearchAppends: string[] = []
  let copySearchBackspaces = 0
  let copySearchSubmits = 0
  let copySearchCancels = 0
  let copySearchClears = 0
  const [copySearchActive, setCopySearchActive] = createSignal(false)
  const [copySearchHighlighted, setCopySearchHighlighted] = createSignal(false)
  let copySearchNexts = 0
  let copySearchPreviouses = 0
  let copyYanks = 0
  let copyYankLines = 0
  let copyCopies = 0
  let copyToggleCollapseds = 0
  let copyActivates = 0
  let copyExitVisuals = 0
  let copyExits = 0
  const copyExitArgs: Array<boolean | undefined> = []
  let copyExitPreserveScrolls = 0
  let copyFocusInputs = 0

  const handler = createVimHandler({
    enabled,
    state,
    textarea: () => textarea,
    register: options?.register?.get,
    setRegister: options?.register?.set,
    pasteOverSelection: options?.pasteOverSelection,
    langmap: () => options?.langmap,
    vimLineMotions: () => options?.vimLineMotions,
    vimEscapeSequence: options?.vimEscapeSequence,
    submit: options?.submit ?? (() => {}),
    commandPalette() {
      commandPaletteCalls.push(true)
      options?.commandPalette?.()
    },
    scroll(action) {
      scrollCalls.push(action)
    },
    jump(action) {
      jumpCalls.push(action)
    },
    navigate(action) {
      navigateCalls.push(action)
    },
    copy(action) {
      copyMoves.push(action)
    },
    copyVisual(mode) {
      copyVisualCalls.push(mode)
      setCopyVisual(mode)
    },
    copyExitVisual() {
      copyExitVisuals++
      setCopyVisual(undefined)
    },
    copyExit(scrollToBottom) {
      copyExits++
      copyExitArgs.push(scrollToBottom)
      setCopyVisual(undefined)
    },
    copyExitPreserveScroll() {
      copyExitPreserveScrolls++
      setCopyVisual(undefined)
    },
    copyFocusInput() {
      copyFocusInputs++
    },
    copyYank() {
      copyYanks++
      state.setRegister({ text: options?.copy?.text ?? "picked", linewise: false })
    },
    copyYankLine() {
      copyYankLines++
      state.setRegister({ text: options?.copy?.text ?? "picked line", linewise: false })
    },
    copyYankMatchingBracket() {
      if (!copyRows) return false
      const next = copyMatchingBracket(copyRows, (idx) => options?.copy?.texts?.[idx] ?? "", copyIdx(), copyCol())
      if (next.idx === copyIdx() && next.col === copyCol()) return false
      const start =
        copyIdx() < next.idx || (copyIdx() === next.idx && copyCol() <= next.col)
          ? { idx: copyIdx(), col: copyCol() }
          : next
      const end = start === next ? { idx: copyIdx(), col: copyCol() } : next
      const text = Array.from({ length: end.idx - start.idx + 1 }, (_, i) => ({
        idx: start.idx + i,
        row: copyRows[start.idx + i],
      }))
        .filter((x): x is { idx: number; row: { col: number } } => !!x.row)
        .map((x) => {
          const line = options?.copy?.texts?.[x.idx] ?? ""
          if (x.idx === start.idx && x.idx === end.idx)
            return line.slice(start.col - x.row.col, end.col - x.row.col + 1)
          if (x.idx === start.idx) return line.slice(start.col - x.row.col)
          if (x.idx === end.idx) return line.slice(0, end.col - x.row.col + 1)
          return line
        })
        .join("\n")
      if (!text) return false
      state.setRegister({ text, linewise: false })
      return true
    },
    copyCopy() {
      copyCopies++
    },
    copyToggleCollapsed() {
      copyToggleCollapseds++
      return options?.copy?.toggleCollapsed?.() ?? false
    },
    copyActivate() {
      copyActivates++
      return options?.copy?.activate?.() ?? false
    },
    copyIsVisual() {
      return copyVisual() !== undefined
    },
    copyHalfPage(direction) {
      copyHalfPages.push(direction)
    },
    copyJump(action) {
      copyJumps.push(action)
    },
    copyWordNext(big) {
      if (!copyRows) return false
      const next = copyWordNext(copyRows, (idx) => options?.copy?.texts?.[idx] ?? "", copyIdx(), copyCol(), big)
      const moved = next.idx !== copyIdx() || next.col !== copyCol()
      setCopyIdx(next.idx)
      setCopyCol(next.col)
      return moved
    },
    copyWordPrev(big) {
      if (!copyRows) return false
      const prev = copyWordPrev(copyRows, (idx) => options?.copy?.texts?.[idx] ?? "", copyIdx(), copyCol(), big)
      const moved = prev.idx !== copyIdx() || prev.col !== copyCol()
      setCopyIdx(prev.idx)
      setCopyCol(prev.col)
      return moved
    },
    copyWordEnd(big) {
      if (!copyRows) return false
      const next = copyWordEnd(copyRows, (idx) => options?.copy?.texts?.[idx] ?? "", copyIdx(), copyCol(), big)
      const moved = next.idx !== copyIdx() || next.col !== copyCol()
      setCopyIdx(next.idx)
      setCopyCol(next.col)
      return moved
    },
    copyMatchingBracket() {
      if (!copyRows) return false
      const next = copyMatchingBracket(copyRows, (idx) => options?.copy?.texts?.[idx] ?? "", copyIdx(), copyCol())
      const moved = next.idx !== copyIdx() || next.col !== copyCol()
      setCopyIdx(next.idx)
      setCopyCol(next.col)
      return moved
    },
    copyNextParagraph() {
      if (!copyRows) return false
      const next = copyNextParagraph(copyRows, (idx) => options?.copy?.texts?.[idx] ?? "", copyIdx())
      const col = copyRows[next.index]?.col ?? 0
      if (next.index === copyIdx() && !next.atEnd && col === copyCol()) return false
      setCopyIdx(next.index)
      setCopyCol(col)
      return true
    },
    copyPreviousParagraph() {
      if (!copyRows) return false
      const previous = copyPreviousParagraph(copyRows, (idx) => options?.copy?.texts?.[idx] ?? "", copyIdx())
      const col = copyRows[previous.index]?.col ?? 0
      if (previous.index === copyIdx() && col === copyCol()) return false
      setCopyIdx(previous.index)
      setCopyCol(col)
      return true
    },
    copySearchStart(direction) {
      if (options?.copySearchAvailable === false) return false
      if (!state.isCopy()) state.setMode("copy")
      copySearchCalls.push(direction)
      setCopySearchActive(true)
      setCopySearchHighlighted(true)
    },
    copySearchAppend(value) {
      copySearchAppends.push(value)
      return true
    },
    copySearchBackspace() {
      copySearchBackspaces++
      return true
    },
    copySearchSubmit() {
      copySearchSubmits++
      setCopySearchActive(false)
      return true
    },
    copySearchCancel() {
      copySearchCancels++
      setCopySearchActive(false)
    },
    copySearchClear() {
      copySearchClears++
      setCopySearchActive(false)
      setCopySearchHighlighted(false)
      return true
    },
    copySearchActive,
    copySearchHighlighted,
    copySearchNext() {
      copySearchNexts++
      return true
    },
    copySearchPrevious() {
      copySearchPreviouses++
      return true
    },
    copyText() {
      return options?.copy?.texts?.[copyIdx()] ?? options?.copy?.text ?? "alpha beta gamma"
    },
    copyCol,
    setCopyCol(offset) {
      setCopyCol(offset)
    },
    setCopyStick() {},
    copyScroll(action: "center" | "top" | "bottom") {
      copyScrollCalls.push(action)
    },
    autocomplete: options?.autocomplete,
    snapshot() {
      return {
        text: textarea.plainText,
        cursor: textarea.cursorOffset,
        data: structuredClone(meta()),
      }
    },
    snapshotDataEqual: options?.snapshotDataEqual,
    restore(next) {
      textarea.setText(next.text)
      textarea.cursorOffset = Math.max(0, Math.min(next.cursor, next.text.length))
      setMeta(next.data)
    },
    flash: options?.flash,
  })

  return {
    textarea,
    handler,
    state,
    scrollCalls,
    jumpCalls,
    navigateCalls,
    commandPaletteCalls,
    copyMoves,
    copyHalfPages,
    copyJumps,
    copyVisual,
    copyVisualCalls,
    copyScrollCalls,
    copySearchCalls,
    copySearchAppends,
    copySearchBackspaces: () => copySearchBackspaces,
    copySearchSubmits: () => copySearchSubmits,
    copySearchCancels: () => copySearchCancels,
    copySearchClears: () => copySearchClears,
    copySearchActive,
    copySearchHighlighted,
    copySearchNexts: () => copySearchNexts,
    copySearchPreviouses: () => copySearchPreviouses,
    copyYanks: () => copyYanks,
    copyYankLines: () => copyYankLines,
    copyCopies: () => copyCopies,
    copyToggleCollapseds: () => copyToggleCollapseds,
    copyActivates: () => copyActivates,
    copyExitVisuals: () => copyExitVisuals,
    copyExits: () => copyExits,
    copyExitArgs,
    copyExitPreserveScrolls: () => copyExitPreserveScrolls,
    copyFocusInputs: () => copyFocusInputs,
    copyCol,
    copyIdx,
    meta,
    setMeta,
  }
}

describe("vim motion handler", () => {
  test("moves with h j k l and clamps to line", () => {
    const ctx = createHandler("abc\nxy")

    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)
    expect(ctx.textarea.cursorOffset).toBe(2)

    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(5)

    ctx.handler.handleKey(createEvent("h").event)
    expect(ctx.textarea.cursorOffset).toBe(4)

    ctx.handler.handleKey(createEvent("k").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("normal colon opens the command palette", () => {
    const ctx = createHandler("abc")
    const event = createEvent(";", { shift: true })

    expect(ctx.handler.handleKey(event.event)).toBe(true)

    expect(ctx.commandPaletteCalls).toHaveLength(1)
    expect(event.prevented()).toBe(true)
  })

  test("normal slash starts forward copy search", () => {
    const ctx = createHandler("abc")
    const event = createEvent("slash")

    expect(ctx.handler.handleKey(event.event)).toBe(true)

    expect(ctx.copySearchCalls).toEqual(["forward"])
    expect(event.prevented()).toBe(true)
  })

  test("normal question mark starts backward copy search", () => {
    const ctx = createHandler("abc")
    const event = createEvent("slash", { shift: true })

    expect(ctx.handler.handleKey(event.event)).toBe(true)

    expect(ctx.copySearchCalls).toEqual(["backward"])
    expect(event.prevented()).toBe(true)
  })

  test("pending operator slash does not start copy search", () => {
    const ctx = createHandler("abc")
    ctx.handler.handleKey(createEvent("d").event)
    const event = createEvent("slash")

    expect(ctx.handler.handleKey(event.event)).toBe(true)

    expect(ctx.copySearchCalls).toHaveLength(0)
    expect(ctx.state.pending()).toBe("")
    expect(event.prevented()).toBe(true)
  })

  test("visual slash does not start copy search", () => {
    const ctx = createHandler("abc")
    ctx.handler.handleKey(createEvent("v").event)
    const event = createEvent("slash")

    expect(ctx.handler.handleKey(event.event)).toBe(true)

    expect(ctx.copySearchCalls).toHaveLength(0)
    expect(ctx.state.mode()).toBe("visual")
    expect(event.prevented()).toBe(true)
  })

  test("count prefixes repeat normal motions and clear after use", () => {
    const ctx = createHandler("abcdef")

    ctx.handler.handleKey(createEvent("3").event)
    expect(ctx.state.count()).toBe("3")
    ctx.handler.handleKey(createEvent("l").event)

    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.count()).toBe("")
  })

  test("ignored count prefixes clear after handled normal commands", () => {
    const ctx = createHandler("abc", { register: { get: () => ({ text: "X", linewise: false }) } })

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("p").event)
    ctx.handler.handleKey(createEvent("l").event)

    expect(ctx.textarea.plainText).toBe("aXbc")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.count()).toBe("")
  })

  test("count prefixes find the nth target for till motions", () => {
    const ctx = createHandler("xaxax")

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("t").event)
    ctx.handler.handleKey(createEvent("a").event)

    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("count prefixes apply to operator find motions", () => {
    const ctx = createHandler("abxcdxef")

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("x").event)

    expect(ctx.textarea.plainText).toBe("ef")
  })

  test("operator-pending counts apply to word motions", () => {
    const ctx = createHandler("one two three four")

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("three four")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "one two ", linewise: false })
  })

  test("operator-pending counts apply to change word-end motions", () => {
    const ctx = createHandler("one two three four")

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("3").event)
    ctx.handler.handleKey(createEvent("e").event)

    expect(ctx.textarea.plainText).toBe(" four")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "one two three", linewise: false })
  })

  test("operator-pending counts apply to yank find motions", () => {
    const ctx = createHandler("abxcdxef")

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("x").event)

    expect(ctx.textarea.plainText).toBe("abxcdxef")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "abxcdx", linewise: false })
  })

  test("operator-pending counts apply to repeated line operators", () => {
    const ctx = createHandler("one\ntwo\nthree")

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("d").event)

    expect(ctx.textarea.plainText).toBe("three")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo", linewise: true })
  })

  test("unsupported counted text objects do not leak counts", () => {
    const ctx = createHandler("one two three")

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("two three")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.count()).toBe("")

    ctx.handler.handleKey(createEvent("l").event)

    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("maps langmap keys in normal mode", () => {
    const ctx = createHandler("abc\nxy", { langmap: { р: "h", о: "j", л: "k", д: "l" } })

    ctx.handler.handleKey(createEvent("д").event)
    ctx.handler.handleKey(createEvent("д").event)
    expect(ctx.textarea.cursorOffset).toBe(2)

    ctx.handler.handleKey(createEvent("о").event)
    expect(ctx.textarea.cursorOffset).toBe(5)

    ctx.handler.handleKey(createEvent("р").event)
    expect(ctx.textarea.cursorOffset).toBe(4)

    ctx.handler.handleKey(createEvent("л").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("maps langmap keys from sequence when name is unavailable", () => {
    const ctx = createHandler("abc\nxy", { langmap: { д: "j" } })

    ctx.handler.handleKey(createEvent("", { sequence: "д" }).event)

    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("maps langmap keys in copy mode", () => {
    const ctx = createHandler("abc", { mode: "copy", langmap: { д: "j" } })

    ctx.handler.handleKey(createEvent("д").event)

    expect(ctx.copyMoves).toEqual(["down"])
  })

  test("maps named printable key aliases", () => {
    const ctx = createHandler("abc", { langmap: { "/": "x" } })

    ctx.handler.handleKey(createEvent("slash").event)

    expect(ctx.textarea.plainText).toBe("bc")
  })

  test("maps langmap paste after clearing invalid pending operator", () => {
    const ctx = createHandler("abc", {
      langmap: { з: "p" },
      register: { get: () => ({ text: "X", linewise: false }), set: () => {} },
    })

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("з").event)

    expect(ctx.state.pending()).toBe("")
    expect(ctx.textarea.plainText).toBe("aXbc")
  })

  test("does not map named special keys", () => {
    const ctx = createHandler("abc", { langmap: { escape: "i" } })

    expect(ctx.handler.handleKey(createEvent("escape").event)).toBe(false)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("does not map langmap keys in insert mode", () => {
    const ctx = createHandler("abc", { mode: "insert", langmap: { д: "l" } })
    expect(ctx.handler.handleKey(createEvent("д").event)).toBe(false)
  })

  test("prevents original event for mapped normal mode keys", () => {
    const ctx = createHandler("abc\nxy", { langmap: { д: "j" } })
    const event = {
      name: "д",
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }

    expect(ctx.handler.handleKey(event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
  })

  test("does not map replacement characters", () => {
    const ctx = createHandler("abc", { langmap: { д: "j" } })

    ctx.handler.handleKey(createEvent("r").event)
    ctx.handler.handleKey(createEvent("д").event)

    expect(ctx.textarea.plainText).toBe("дbc")
  })

  test("does not map find target characters", () => {
    const ctx = createHandler("abcдj", { langmap: { а: "f", д: "j" } })

    ctx.handler.handleKey(createEvent("а").event)
    ctx.handler.handleKey(createEvent("д").event)

    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("h clamps at line start", () => {
    const ctx = createHandler("abc\ndef")
    ctx.textarea.cursorOffset = 4
    ctx.handler.handleKey(createEvent("h").event)
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("l clamps at line end", () => {
    const ctx = createHandler("ab\ncd")
    ctx.textarea.cursorOffset = 1
    ctx.handler.handleKey(createEvent("l").event)
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("j on last line stays", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("k on first line stays", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    ctx.handler.handleKey(createEvent("k").event)
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("j/k move across leading empty first line", () => {
    const text = "\nline1\nline2\nline3\n"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 1, 0)

    ctx.handler.handleKey(createEvent("k").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 0, 0))

    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 0))
  })

  test("j/k move across trailing empty last line", () => {
    const text = "\nline1\nline2\nline3\n"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 3, 0)

    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 4, 0))

    ctx.handler.handleKey(createEvent("k").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 3, 0))
  })

  test("j and k preserve desired column across short lines", () => {
    const text = "abcdef\nx\nabcdef"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 0, 5)

    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 0))

    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 5))

    ctx.handler.handleKey(createEvent("k").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 0))

    ctx.handler.handleKey(createEvent("k").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 0, 5))
  })

  test("arrow up and down preserve desired column across short lines", () => {
    const text = "abcdef\nx\nabcdef"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 0, 4)

    ctx.handler.handleKey(createEvent("down").event)
    ctx.handler.handleKey(createEvent("down").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 4))

    ctx.handler.handleKey(createEvent("up").event)
    ctx.handler.handleKey(createEvent("up").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 0, 4))
  })

  test("non-vertical motion resets desired column", () => {
    const text = "abcdef\nx\nabcdef"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 0, 5)

    ctx.handler.handleKey(createEvent("j").event)
    ctx.handler.handleKey(createEvent("h").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 0))
  })

  test("shifted j join resets desired column", () => {
    const text = "abcdef\nx\nabc\nabcdef"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 0, 5)

    ctx.handler.handleKey(createEvent("j").event)
    ctx.handler.handleKey(createEvent("j", { shift: true }).event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.plainText).toBe("abcdef\nx abc\nabcdef")
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(ctx.textarea.plainText, 2, 1))
  })

  test("$ makes vertical movement stick to line end", () => {
    const text = "abc\ndefgh\nxy"
    const ctx = createHandler(text)

    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 0, 2))

    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 4))

    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 1))
  })

  test("supports word and big-word key shapes", () => {
    const ctx = createHandler("foo,bar baz")

    const w = createEvent("w")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(w.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(3)

    const upperW = createEvent("W")
    expect(ctx.handler.handleKey(upperW.event)).toBe(true)
    expect(upperW.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(8)

    ctx.textarea.cursorOffset = 0
    const shiftW = createEvent("w", { shift: true })
    expect(ctx.handler.handleKey(shiftW.event)).toBe(true)
    expect(shiftW.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(8)

    const upperE = createEvent("E")
    expect(ctx.handler.handleKey(upperE.event)).toBe(true)
    expect(upperE.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(10)

    const upperB = createEvent("B")
    expect(ctx.handler.handleKey(upperB.event)).toBe(true)
    expect(upperB.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(8)
  })

  test("e stays on single-char word", () => {
    const ctx = createHandler("a")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("e from end of word moves to next word end", () => {
    const ctx = createHandler("a b")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("e from word end moves to next word end", () => {
    const ctx = createHandler("ab cd")
    ctx.textarea.cursorOffset = 1
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("e from whitespace moves to next word end", () => {
    const ctx = createHandler("ab  cd")
    ctx.textarea.cursorOffset = 2
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.cursorOffset).toBe(5)
  })

  test("e treats punct cluster as its own word", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 2
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.cursorOffset).toBe(5)
  })

  test("e from inside punct cluster lands on its last char", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 4
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.cursorOffset).toBe(5)
  })

  test("e from end of punct cluster advances to next word end", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 5
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.cursorOffset).toBe(8)
  })

  test("e on standalone trailing punct stays put", () => {
    const ctx = createHandler("hello!")
    ctx.textarea.cursorOffset = 5
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.cursorOffset).toBe(5)
  })

  test("E treats punct as part of bigword", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("E").event)
    expect(ctx.textarea.cursorOffset).toBe(8)
  })

  test("b moves to previous word start", () => {
    const ctx = createHandler("foo bar baz")
    ctx.textarea.cursorOffset = 8
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("b at start of text stays", () => {
    const ctx = createHandler("foo bar")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("b treats punctuation as its own word", () => {
    const ctx = createHandler("foo,bar")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("w lands on trailing punctuation", () => {
    const ctx = createHandler("changed?")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.textarea.cursorOffset).toBe(7)
  })

  test("w advances from punctuation to next word", () => {
    const ctx = createHandler("changed? next")
    ctx.textarea.cursorOffset = 7

    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.textarea.cursorOffset).toBe(9)
  })

  test("W treats punctuation as part of big word", () => {
    const ctx = createHandler("changed? next")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("W").event)
    expect(ctx.textarea.cursorOffset).toBe(9)
  })

  test("0 moves to line beginning", () => {
    const ctx = createHandler("  hello")
    ctx.textarea.cursorOffset = 4
    ctx.handler.handleKey(createEvent("0").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("0 on multiline moves to current line start", () => {
    const ctx = createHandler("abc\n  def")
    ctx.textarea.cursorOffset = 7
    ctx.handler.handleKey(createEvent("0").event)
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("^ moves to first non-whitespace", () => {
    const ctx = createHandler("  hello")
    ctx.textarea.cursorOffset = 5
    ctx.handler.handleKey(createEvent("^").event)
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("^ on line with no leading whitespace goes to column 0", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 3
    ctx.handler.handleKey(createEvent("^").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("_ moves to first non-whitespace like ^", () => {
    const ctx = createHandler("  hello")
    ctx.textarea.cursorOffset = 5
    ctx.handler.handleKey(createEvent("_").event)
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("$ moves to last char of line", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("$ on multiline moves to last char of current line", () => {
    const ctx = createHandler("abc\ndef")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("$ on single char stays put", () => {
    const ctx = createHandler("a")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("^ on all-whitespace line goes to end", () => {
    const ctx = createHandler("   ")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("^").event)
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("$ on empty line in multiline", () => {
    const ctx = createHandler("abc\n\ndef")
    ctx.textarea.cursorOffset = 4
    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("% jumps from opening bracket to matching close", () => {
    const ctx = createHandler("a (b [c]) d")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("%").event)
    expect(ctx.textarea.cursorOffset).toBe(8)
  })

  test("% searches forward on current line for a bracket", () => {
    const ctx = createHandler("a (b)")

    ctx.handler.handleKey(createEvent("%").event)
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("% matches brackets across lines", () => {
    const ctx = createHandler("{\n  [x]\n}")

    ctx.handler.handleKey(createEvent("%").event)
    expect(ctx.textarea.cursorOffset).toBe(8)
  })

  test("% leaves cursor in place for unmatched bracket", () => {
    const ctx = createHandler("(abc")

    ctx.handler.handleKey(createEvent("%").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("d% deletes through matching bracket", () => {
    const ctx = createHandler("(abc) def")

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("%").event)

    expect(ctx.textarea.plainText).toBe(" def")
    expect(ctx.state.register()).toEqual({ text: "(abc)", linewise: false })
  })

  test("d% searches forward from non-bracket cursor like vim", () => {
    const ctx = createHandler("a (b) c")

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("%").event)

    expect(ctx.textarea.plainText).toBe(" c")
    expect(ctx.state.register()).toEqual({ text: "a (b)", linewise: false })
  })

  test("d% from closing bracket deletes back through match", () => {
    const ctx = createHandler("(abc) def")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("%").event)

    expect(ctx.textarea.plainText).toBe(" def")
    expect(ctx.state.register()).toEqual({ text: "(abc)", linewise: false })
  })

  test("y% yanks through matching bracket", () => {
    const ctx = createHandler("(abc) def")

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("%").event)

    expect(ctx.textarea.plainText).toBe("(abc) def")
    expect(ctx.state.register()).toEqual({ text: "(abc)", linewise: false })
  })

  test("c% changes through matching bracket", () => {
    const ctx = createHandler("(abc) def")

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("%").event)

    expect(ctx.textarea.plainText).toBe(" def")
    expect(ctx.state.register()).toEqual({ text: "(abc)", linewise: false })
    expect(ctx.state.mode()).toBe("insert")
  })

  test("} jumps to the next blank line", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(8)
  })

  test("} lands on the first of consecutive blank lines", () => {
    const ctx = createHandler("a\n\n\n\nb")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("} from a blank line skips blanks then next paragraph", () => {
    const ctx = createHandler("a\n\n\nb\n\nc")
    ctx.textarea.cursorOffset = 2
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(6)
  })

  test("{ jumps to the previous blank line", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 14
    ctx.handler.handleKey(createEvent("{").event)
    expect(ctx.textarea.cursorOffset).toBe(8)
  })

  test("{ at start of buffer stays at 0", () => {
    const ctx = createHandler("abc\ndef")
    ctx.textarea.cursorOffset = 2
    ctx.handler.handleKey(createEvent("{").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("} with no blank lines lands on last char", () => {
    const ctx = createHandler("only\nparagraph")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(13)
  })

  test("} does not treat whitespace-only line as blank", () => {
    const ctx = createHandler("a\n   \nb")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(6)
  })

  test("{ does not treat whitespace-only line as blank", () => {
    const ctx = createHandler("a\n\t \nb")
    ctx.textarea.cursorOffset = 5
    ctx.handler.handleKey(createEvent("{").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("} with trailing newline lands on the trailing empty line", () => {
    const ctx = createHandler("abc\n\ndef\n")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("} with trailing newline lands on last char of last line", () => {
    const ctx = createHandler("abc\n")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("} with no blank line but trailing newline lands on last char of last line", () => {
    const ctx = createHandler("one\ntwo\n")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(6)
  })

  test("} with no blank lines anywhere goes to last char", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(12)
  })

  test("{ with no blank lines anywhere goes to start", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 10
    ctx.handler.handleKey(createEvent("{").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("d} deletes through next paragraph boundary", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("}")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("\nthree\nfour")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo\n", linewise: true })
  })

  test("counted d} deletes through target paragraph boundary", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour\n\nfive")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("}")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("\nfive")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo\n\nthree\nfour\n", linewise: true })
  })

  test("counted c} changes through target paragraph boundary", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour\n\nfive")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("c").event)
    const motion = createEvent("}")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("\n\nfive")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo\n\nthree\nfour\n", linewise: true })
  })

  test("counted y{ yanks backward through target paragraph boundary", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour\n\nfive")
    ctx.textarea.cursorOffset = 21

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("y").event)
    const motion = createEvent("{")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\ntwo\n\nthree\nfour\n\nfive")
    expect(ctx.textarea.cursorOffset).toBe(21)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "\nthree\nfour\n\n", linewise: true })
  })

  test("counted c{ changes backward through target paragraph boundary", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour\n\nfive")
    ctx.textarea.cursorOffset = 21

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("c").event)
    const motion = createEvent("{")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\ntwo\n\nfive")
    expect(ctx.textarea.cursorOffset).toBe(8)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "\nthree\nfour\n", linewise: true })
  })

  test("d{ deletes backward through previous paragraph boundary", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 13

    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("{")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\ntwo\ne\nfour")
    expect(ctx.textarea.cursorOffset).toBe(8)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "\nthre", linewise: false })
  })

  test("c} deletes through next paragraph boundary and enters insert", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    const motion = createEvent("}")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    // c linewise preserves the line separator before the blank, unlike d
    expect(ctx.textarea.plainText).toBe("\n\nthree\nfour")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo\n", linewise: true })
  })

  test("c} on last char of last paragraph deletes the char and enters insert", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 12

    ctx.handler.handleKey(createEvent("c").event)
    const motion = createEvent("}")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\ntwo\nthre")
    expect(ctx.textarea.cursorOffset).toBe(12)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "e", linewise: false })
  })

  test("y} yanks through next paragraph boundary", () => {
    const flashes: Array<{ start: number; end: number }> = []
    const ctx = createHandler("one\ntwo\n\nthree\nfour", { flash: (span) => flashes.push(span) })
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    const motion = createEvent("}")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\ntwo\n\nthree\nfour")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo\n", linewise: true })
    expect(flashes).toEqual([{ start: 0, end: 8 }])
  })

  test("y} on last char of last paragraph yanks the char", () => {
    const flashes: Array<{ start: number; end: number }> = []
    const ctx = createHandler("one\ntwo\nthree", { flash: (span) => flashes.push(span) })
    ctx.textarea.cursorOffset = 12

    ctx.handler.handleKey(createEvent("y").event)
    const motion = createEvent("}")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\ntwo\nthree")
    expect(ctx.textarea.cursorOffset).toBe(12)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "e", linewise: false })
    expect(flashes).toEqual([{ start: 12, end: 13 }])
  })

  test("d} on last char of last paragraph deletes the char", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 12

    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("}")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\ntwo\nthre")
    expect(ctx.textarea.cursorOffset).toBe(12)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "e", linewise: false })
  })

  test("y{ yanks backward through previous paragraph boundary", () => {
    const flashes: Array<{ start: number; end: number }> = []
    const ctx = createHandler("one\ntwo\n\nthree\nfour", { flash: (span) => flashes.push(span) })
    ctx.textarea.cursorOffset = 13

    ctx.handler.handleKey(createEvent("y").event)
    const motion = createEvent("{")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\ntwo\n\nthree\nfour")
    expect(ctx.textarea.cursorOffset).toBe(13)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "\nthre", linewise: false })
    expect(flashes).toEqual([{ start: 8, end: 13 }])
  })

  test("v then } extends selection to next blank line", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(8)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 0, end: 9 })
  })

  test("v then { extends selection backward to previous blank line", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 14

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("{").event)
    expect(ctx.textarea.cursorOffset).toBe(8)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 8, end: 15 })
  })

  test("V then } extends linewise selection across paragraph", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("V").event)
    expect(ctx.state.mode()).toBe("visual-line")
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.cursorOffset).toBe(8)
  })

  test("v then } then d deletes selection charwise through blank", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("}").event)
    ctx.handler.handleKey(createEvent("d").event)

    expect(ctx.textarea.plainText).toBe("three\nfour")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo\n\n", linewise: false })
  })

  test("v then } then y yanks selection charwise", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("}").event)
    ctx.handler.handleKey(createEvent("y").event)

    expect(ctx.textarea.plainText).toBe("one\ntwo\n\nthree\nfour")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo\n\n", linewise: false })
  })

  test("v then { then d deletes selection charwise backward", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 14

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("{").event)
    ctx.handler.handleKey(createEvent("d").event)

    expect(ctx.textarea.plainText).toBe("one\ntwo\nfour")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "\nthree\n", linewise: false })
  })

  test("V then } then d deletes full lines linewise", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("}").event)
    ctx.handler.handleKey(createEvent("d").event)

    expect(ctx.textarea.plainText).toBe("three\nfour")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()?.linewise).toBe(true)
  })

  test("V then } then y yanks full lines linewise", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("}").event)
    ctx.handler.handleKey(createEvent("y").event)

    expect(ctx.textarea.plainText).toBe("one\ntwo\n\nthree\nfour")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()?.linewise).toBe(true)
  })

  test("o toggles cursor to other end of selection in visual mode", () => {
    const ctx = createHandler("line one\nline two\nline three\nline four")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("j").event)
    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(ctx.textarea.plainText, 2, 0))
    expect(ctx.state.anchor()).toBe(0)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({
      start: 0,
      end: rowColToOffset(ctx.textarea.plainText, 2, 0) + 1,
    })

    ctx.handler.handleKey(createEvent("o").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.anchor()).toBe(rowColToOffset(ctx.textarea.plainText, 2, 0))
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({
      start: 0,
      end: rowColToOffset(ctx.textarea.plainText, 2, 0) + 1,
    })
  })

  test("o toggles cursor when cursor is above anchor", () => {
    const ctx = createHandler("line one\nline two\nline three\nline four")
    const bottom = rowColToOffset(ctx.textarea.plainText, 2, 0)
    ctx.textarea.cursorOffset = bottom
    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("k").event)
    ctx.handler.handleKey(createEvent("k").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.anchor()).toBe(bottom)

    ctx.handler.handleKey(createEvent("o").event)
    expect(ctx.textarea.cursorOffset).toBe(bottom)
    expect(ctx.state.anchor()).toBe(0)
  })

  test("o in visual-line mode toggles to other end", () => {
    const ctx = createHandler("line one\nline two\nline three\nline four")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("j").event)
    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(ctx.textarea.plainText, 2, 0))
    expect(ctx.state.anchor()).toBe(0)

    ctx.handler.handleKey(createEvent("o").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.anchor()).toBe(rowColToOffset(ctx.textarea.plainText, 2, 0))
  })

  test("o is a no-op when cursor equals anchor", () => {
    const ctx = createHandler("line one\nline two")
    ctx.textarea.cursorOffset = 5
    ctx.handler.handleKey(createEvent("v").event)
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.anchor()).toBe(5)

    ctx.handler.handleKey(createEvent("o").event)
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.anchor()).toBe(5)
  })

  test("after o toggle, movement extends from new cursor position", () => {
    const ctx = createHandler("line one\nline two\nline three\nline four")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("j").event)
    ctx.handler.handleKey(createEvent("j").event)
    ctx.handler.handleKey(createEvent("o").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.anchor()).toBe(rowColToOffset(ctx.textarea.plainText, 2, 0))

    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(ctx.textarea.plainText, 1, 0))
    expect(ctx.state.anchor()).toBe(rowColToOffset(ctx.textarea.plainText, 2, 0))
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({
      start: rowColToOffset(ctx.textarea.plainText, 1, 0),
      end: rowColToOffset(ctx.textarea.plainText, 2, 0) + 1,
    })
  })

  test("supports insert transitions for A I O", () => {
    const i0 = createHandler("abc")
    i0.textarea.cursorOffset = 1
    expect(i0.handler.handleKey(createEvent("i").event)).toBe(true)
    expect(i0.state.mode()).toBe("insert")
    expect(i0.textarea.cursorOffset).toBe(1)

    const i = createHandler("  abc")
    i.textarea.cursorOffset = 1
    expect(i.handler.handleKey(createEvent("I").event)).toBe(true)
    expect(i.state.mode()).toBe("insert")
    expect(i.textarea.cursorOffset).toBe(2)

    const a = createHandler("  abc")
    a.textarea.cursorOffset = 1
    expect(a.handler.handleKey(createEvent("A").event)).toBe(true)
    expect(a.state.mode()).toBe("insert")
    expect(a.textarea.cursorOffset).toBe(5)

    const o = createHandler("abc")
    o.textarea.cursorOffset = 1
    expect(o.handler.handleKey(createEvent("o", { shift: true }).event)).toBe(true)
    expect(o.state.mode()).toBe("insert")
    expect(o.textarea.plainText).toBe("\nabc")
  })

  test("a appends after cursor", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    expect(ctx.handler.handleKey(createEvent("a").event)).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("a at end of line stays at end", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 2
    expect(ctx.handler.handleKey(createEvent("a").event)).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("escape from insert clamps cursor off newline", () => {
    const ctx = createHandler("ab\ncd")
    ctx.textarea.cursorOffset = 0

    expect(ctx.handler.handleKey(createEvent("x").event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("b\ncd")
    expect(ctx.state.register()).toEqual({ text: "a", linewise: false })

    expect(ctx.handler.handleKey(createEvent("A").event)).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.cursorOffset).toBe(1)

    expect(ctx.handler.handleKey(createEvent("escape").event)).toBe(true)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.textarea.cursorOffset).toBe(0)

    expect(ctx.handler.handleKey(createEvent("p").event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("ba\ncd")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("escape from empty insert moves cursor back like vim", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    expect(ctx.handler.handleKey(createEvent("i").event)).toBe(true)
    expect(ctx.state.mode()).toBe("insert")

    expect(ctx.handler.handleKey(createEvent("escape").event)).toBe(true)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("o opens line below and enters insert", () => {
    const ctx = createHandler("abc\ndef")
    ctx.textarea.cursorOffset = 1
    expect(ctx.handler.handleKey(createEvent("o").event)).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("abc\n\ndef")
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("o on last line opens line below", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    expect(ctx.handler.handleKey(createEvent("o").event)).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("abc\n")
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("O on first line inserts line above", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    expect(ctx.handler.handleKey(createEvent("O").event)).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("\nabc")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("backspace is consumed in normal mode", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    const bs = createEvent("backspace")
    expect(ctx.handler.handleKey(bs.event)).toBe(true)
    expect(bs.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("abc")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("delete is consumed in normal mode", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    const del = createEvent("delete")
    expect(ctx.handler.handleKey(del.event)).toBe(true)
    expect(del.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("abc")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("printable keys are consumed in normal mode", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    const z = createEvent("z")
    expect(ctx.handler.handleKey(z.event)).toBe(true)
    expect(z.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("abc")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("printable keys with modifiers pass through", () => {
    const ctx = createHandler("abc")
    const v = createEvent("v", { ctrl: true })
    expect(ctx.handler.handleKey(v.event)).toBe(false)
    expect(v.prevented()).toBe(false)
  })

  test("x deletes under cursor and no-ops at end", () => {
    const a = createHandler("abc")
    a.textarea.cursorOffset = 1
    const x = createEvent("x")
    expect(a.handler.handleKey(x.event)).toBe(true)
    expect(x.prevented()).toBe(true)
    expect(a.textarea.plainText).toBe("ac")
    expect(a.textarea.cursorOffset).toBe(1)

    const b = createHandler("ab\ncd")
    b.textarea.cursorOffset = 2
    expect(b.handler.handleKey(createEvent("x").event)).toBe(true)
    expect(b.textarea.plainText).toBe("ab\ncd")
    expect(b.textarea.cursorOffset).toBe(2)
  })

  test("x on last char moves left like vim", () => {
    const a = createHandler("abc")
    a.textarea.cursorOffset = 2
    expect(a.handler.handleKey(createEvent("x").event)).toBe(true)
    expect(a.textarea.plainText).toBe("ab")
    expect(a.textarea.cursorOffset).toBe(1)

    const b = createHandler("ab\ncd")
    b.textarea.cursorOffset = 1
    expect(b.handler.handleKey(createEvent("x").event)).toBe(true)
    expect(b.textarea.plainText).toBe("a\ncd")
    expect(b.textarea.cursorOffset).toBe(0)
  })

  test("uses custom register setter", () => {
    let reg = null as { text: string; linewise: boolean } | null
    const ctx = createHandler("abc", {
      register: {
        set(next) {
          reg = next
        },
      },
    })

    ctx.textarea.cursorOffset = 1
    expect(ctx.handler.handleKey(createEvent("x").event)).toBe(true)
    expect(reg).toEqual({ text: "b", linewise: false })
    expect(ctx.state.register()).toBe(null)
  })

  test("~ toggles case and moves right like vim", () => {
    const ctx = createHandler("a.")

    const a = createEvent("~")
    expect(ctx.handler.handleKey(a.event)).toBe(true)
    expect(a.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("A.")
    expect(ctx.textarea.cursorOffset).toBe(1)

    const dot = createEvent("~")
    expect(ctx.handler.handleKey(dot.event)).toBe(true)
    expect(dot.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("A.")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("~ on last char stays on that char", () => {
    const ctx = createHandler("ab")
    ctx.textarea.cursorOffset = 1

    expect(ctx.handler.handleKey(createEvent("~").event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("aB")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("x on empty string is a no-op", () => {
    const ctx = createHandler("")
    const x = createEvent("x")
    expect(ctx.handler.handleKey(x.event)).toBe(true)
    expect(x.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("")
  })

  test("s deletes character under cursor and enters insert", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    const s = createEvent("s")

    expect(ctx.handler.handleKey(s.event)).toBe(true)
    expect(s.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("ac")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.register()).toEqual({ text: "b", linewise: false })
  })

  test("s at end of line enters insert without changes", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 3
    const s = createEvent("s")

    expect(ctx.handler.handleKey(s.event)).toBe(true)
    expect(s.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("abc")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.register()).toBeNull()
  })

  test("s on empty string enters insert", () => {
    const ctx = createHandler("")
    const s = createEvent("s")

    expect(ctx.handler.handleKey(s.event)).toBe(true)
    expect(s.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("s on single character deletes and enters insert", () => {
    const ctx = createHandler("a")
    ctx.textarea.cursorOffset = 0
    const s = createEvent("s")

    expect(ctx.handler.handleKey(s.event)).toBe(true)
    expect(s.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "a", linewise: false })
  })

  test("s on multiline deletes character at cursor", () => {
    const ctx = createHandler("ab\ncd")
    ctx.textarea.cursorOffset = 1
    const s = createEvent("s")

    expect(ctx.handler.handleKey(s.event)).toBe(true)
    expect(s.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("a\ncd")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.register()).toEqual({ text: "b", linewise: false })
  })

  test("S clears current line and enters insert", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5
    const s = createEvent("S")

    expect(ctx.handler.handleKey(s.event)).toBe(true)
    expect(s.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("one\n\nthree")
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("S clears single line", () => {
    const ctx = createHandler("abc")
    const s = createEvent("S")

    expect(ctx.handler.handleKey(s.event)).toBe(true)
    expect(s.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("S keeps empty buffer", () => {
    const ctx = createHandler("")
    const s = createEvent("S")

    expect(ctx.handler.handleKey(s.event)).toBe(true)
    expect(s.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("D deletes to end of line and populates charwise register", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5
    const d = createEvent("D")

    expect(ctx.handler.handleKey(d.event)).toBe(true)
    expect(d.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.textarea.plainText).toBe("one\nt\nthree")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.register()).toEqual({ text: "wo", linewise: false })
  })

  test("C deletes to end of line, enters insert, and populates register", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5
    const c = createEvent("C")

    expect(ctx.handler.handleKey(c.event)).toBe(true)
    expect(c.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("one\nt\nthree")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toEqual({ text: "wo", linewise: false })
  })

  test("C on empty line enters insert without changes", () => {
    const ctx = createHandler("one\n\nthree")
    ctx.textarea.cursorOffset = 4
    const c = createEvent("C")

    expect(ctx.handler.handleKey(c.event)).toBe(true)
    expect(c.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("one\n\nthree")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.register()).toBeNull()
  })

  test("cc clears current line and enters insert", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    const c1 = createEvent("c")
    expect(ctx.handler.handleKey(c1.event)).toBe(true)
    expect(c1.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("c")

    const c2 = createEvent("c")
    expect(ctx.handler.handleKey(c2.event)).toBe(true)
    expect(c2.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("one\n\nthree")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
  })

  test("counted cc clears multiple lines and enters insert", () => {
    const ctx = createHandler("one\ntwo\nthree\nfour")

    ctx.handler.handleKey(createEvent("3").event)
    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("c").event)

    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("\nfour")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo\nthree", linewise: true })
  })

  test("c$ changes to end of line", () => {
    const ctx = createHandler("one\ntwo three\nfour")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("c").event)
    const motion = createEvent("$")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\nt\nfour")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "wo three", linewise: false })
  })

  test("counted c$ changes through target line end", () => {
    const ctx = createHandler("one\ntwo three\nfour")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("c").event)
    const motion = createEvent("$")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\nt")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "wo three\nfour", linewise: false })
  })

  test("c$ at end of line is no-op", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.pending()).toBe("")
  })

  test("c0 changes to beginning of line", () => {
    const ctx = createHandler("one\ntwo three\nfour")
    ctx.textarea.cursorOffset = 9

    ctx.handler.handleKey(createEvent("c").event)
    const motion = createEvent("0")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\nhree\nfour")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two t", linewise: false })
  })

  test("c0 at beginning of line is no-op", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("0").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.pending()).toBe("")
  })

  test("c^ changes back to first non-whitespace", () => {
    const ctx = createHandler("one\n  two three")
    ctx.textarea.cursorOffset = 10

    ctx.handler.handleKey(createEvent("c").event)
    const motion = createEvent("^")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\n  three")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two ", linewise: false })
  })

  test("c^ changes forward to first non-whitespace", () => {
    const ctx = createHandler("one\n  two")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("^").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "  ", linewise: false })
  })

  test("cw changes to end of word and enters insert", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 0

    const c = createEvent("c")
    expect(ctx.handler.handleKey(c.event)).toBe(true)
    expect(ctx.state.pending()).toBe("c")

    const w = createEvent("w")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(w.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe(" world test")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("cw from mid-word changes to end of word", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.textarea.plainText).toBe("he world")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "llo", linewise: false })
  })

  test("cw on punctuation changes punctuation word", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.textarea.plainText).toBe("foobar")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "!!!", linewise: false })
  })

  test("cw from whitespace changes through next word start", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.textarea.plainText).toBe("helloworld")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: " ", linewise: false })
  })

  test("cW changes through end of big word and enters insert", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    const w = createEvent("W")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(w.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe(" baz")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "foo.bar", linewise: false })
  })

  test("cW from whitespace changes through next big word start", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 7

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("W").event)
    expect(ctx.textarea.plainText).toBe("foo.barbaz")
    expect(ctx.textarea.cursorOffset).toBe(7)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: " ", linewise: false })
  })

  test("pending c clears on escape", () => {
    const ctx = createHandler("hello world")

    expect(ctx.handler.handleKey(createEvent("c").event)).toBe(true)
    expect(ctx.state.pending()).toBe("c")

    const esc = createEvent("escape")
    expect(ctx.handler.handleKey(esc.event)).toBe(true)
    expect(esc.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.textarea.plainText).toBe("hello world")
  })

  test("pending c clears on modifier key", () => {
    const ctx = createHandler("abc")

    expect(ctx.handler.handleKey(createEvent("c").event)).toBe(true)
    expect(ctx.state.pending()).toBe("c")

    const mod = createEvent("j", { ctrl: true })
    expect(ctx.handler.handleKey(mod.event)).toBe(false)
    expect(mod.prevented()).toBe(false)
    expect(ctx.state.pending()).toBe("")
  })

  test("pending c clears on non-motion key and key is handled", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 2

    expect(ctx.handler.handleKey(createEvent("c").event)).toBe(true)
    expect(ctx.state.pending()).toBe("c")

    const h = createEvent("h")
    expect(ctx.handler.handleKey(h.event)).toBe(true)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("ctrl+w k navigates to copy mode", () => {
    const ctx = createHandler("abc")

    expect(ctx.handler.handleKey(createEvent("w", { ctrl: true }).event)).toBe(true)
    expect(ctx.state.pending()).toBe("w")

    const k = createEvent("k")
    expect(ctx.handler.handleKey(k.event)).toBe(true)
    expect(k.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.navigateCalls).toEqual(["up"])
  })

  test("ctrl+w ctrl+k navigates to copy mode (ctrl held throughout)", () => {
    const ctx = createHandler("abc")

    expect(ctx.handler.handleKey(createEvent("w", { ctrl: true }).event)).toBe(true)
    expect(ctx.state.pending()).toBe("w")

    const k = createEvent("k", { ctrl: true })
    expect(ctx.handler.handleKey(k.event)).toBe(true)
    expect(k.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.navigateCalls).toEqual(["up"])
  })

  test("ctrl+w ctrl+j navigates down (ctrl held throughout)", () => {
    const ctx = createHandler("abc")

    expect(ctx.handler.handleKey(createEvent("w", { ctrl: true }).event)).toBe(true)
    expect(ctx.state.pending()).toBe("w")

    const j = createEvent("j", { ctrl: true })
    expect(ctx.handler.handleKey(j.event)).toBe(true)
    expect(j.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.navigateCalls).toEqual(["down"])
  })

  test("ctrl+w invalid key clears pending in normal mode", () => {
    const ctx = createHandler("abc")

    expect(ctx.handler.handleKey(createEvent("w", { ctrl: true }).event)).toBe(true)
    expect(ctx.state.pending()).toBe("w")

    const x = createEvent("x")
    expect(ctx.handler.handleKey(x.event)).toBe(true)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.navigateCalls).toEqual([])
  })

  test("meta+w does not set ctrl-w pending", () => {
    const ctx = createHandler("abc")

    expect(ctx.handler.handleKey(createEvent("w", { meta: true }).event)).toBe(false)
    expect(ctx.state.pending()).toBe("")
  })

  test("escape in normal mode with no pending returns false", () => {
    const ctx = createHandler("abc")
    const esc = createEvent("escape")
    expect(ctx.handler.handleKey(esc.event)).toBe(false)
    expect(esc.prevented()).toBe(false)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("insert mode only handles escape", () => {
    const ctx = createHandler("abc", { mode: "insert" })
    ctx.textarea.cursorOffset = 2

    const w = createEvent("w")
    expect(ctx.handler.handleKey(w.event)).toBe(false)
    expect(w.prevented()).toBe(false)

    const esc = createEvent("escape")
    expect(ctx.handler.handleKey(esc.event)).toBe(true)
    expect(esc.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("escape from insert mode moves cursor back like vim", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("i").event)
    ctx.textarea.insertText("X")
    ctx.textarea.insertText("Y")
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("aXYbcd")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("escape from insert mode stays on inserted text at end of line", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("a").event)
    ctx.textarea.insertText("X")
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("abcdX")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("escape from insert mode stays on a new empty line", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("o").event)
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("abc\n")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("db after insert escape keeps the character under cursor like vim", () => {
    const ctx = createHandler("")

    ctx.handler.handleKey(createEvent("i").event)
    ctx.textarea.insertText("word")
    ctx.handler.handleKey(createEvent("escape").event)
    expect(ctx.textarea.cursorOffset).toBe(3)

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.plainText).toBe("d")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("r replaces one character and stays normal", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    const start = createEvent("r")
    expect(ctx.handler.handleKey(start.event)).toBe(true)
    expect(start.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("r")

    const replacement = createEvent("X")
    expect(ctx.handler.handleKey(replacement.event)).toBe(true)
    expect(replacement.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("aXcd")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.pending()).toBe("")
  })

  test("r replaces with space", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("r").event)
    ctx.handler.handleKey(createEvent("space").event)

    expect(ctx.textarea.plainText).toBe("ab d")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("r replaces last character without moving left", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("r").event)
    ctx.handler.handleKey(createEvent("d").event)

    expect(ctx.textarea.plainText).toBe("abd")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("r return replaces character with newline and moves to next line", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("r").event)
    ctx.handler.handleKey(createEvent("return").event)

    expect(ctx.textarea.plainText).toBe("a\ncd")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("r does not insert on empty line", () => {
    const ctx = createHandler("ab\n\ncd")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("r").event)
    ctx.handler.handleKey(createEvent("X").event)

    expect(ctx.textarea.plainText).toBe("ab\n\ncd")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.pending()).toBe("")
  })

  test("r replaces with uppercase characters before jump handling", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("r").event)
    ctx.handler.handleKey(createEvent("G").event)

    expect(ctx.textarea.plainText).toBe("aGcd")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.jumpCalls).toEqual([])
  })

  test("R enters replace mode and escape exits", () => {
    const ctx = createHandler("abc")

    const enter = createEvent("R")
    expect(ctx.handler.handleKey(enter.event)).toBe(true)
    expect(enter.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("replace")

    const esc = createEvent("escape")
    expect(ctx.handler.handleKey(esc.event)).toBe(true)
    expect(esc.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("shift+r also enters replace mode", () => {
    const ctx = createHandler("abc")

    const enter = createEvent("r", { shift: true })
    expect(ctx.handler.handleKey(enter.event)).toBe(true)
    expect(enter.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("replace")
  })

  test("R clears pending operator when entering replace mode", () => {
    const ctx = createHandler("abc")
    ctx.state.setPending("d")

    expect(ctx.handler.handleKey(createEvent("R").event)).toBe(true)
    expect(ctx.state.mode()).toBe("replace")
    expect(ctx.state.pending()).toBe("")
  })

  test("replace mode overwrites characters and advances", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("R").event)
    ctx.handler.handleKey(createEvent("X").event)
    ctx.handler.handleKey(createEvent("Y").event)

    expect(ctx.textarea.plainText).toBe("aXYd")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.mode()).toBe("replace")
  })

  test("replace mode preserves shifted uppercase letters", () => {
    const ctx = createHandler("abcd", { mode: "replace" })
    ctx.textarea.cursorOffset = 1

    const key = createEvent("x", { shift: true })
    expect(ctx.handler.handleKey(key.event)).toBe(true)
    expect(key.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("aXcd")
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("replace mode overwrites with space key", () => {
    const ctx = createHandler("abcd", { mode: "replace" })
    ctx.textarea.cursorOffset = 1

    const key = createEvent("space")
    expect(ctx.handler.handleKey(key.event)).toBe(true)
    expect(key.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("a cd")
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("replace mode inserts at line end without removing newline", () => {
    const ctx = createHandler("ab\ncd", { mode: "replace" })
    ctx.textarea.cursorOffset = 2

    const key = createEvent("X")
    expect(ctx.handler.handleKey(key.event)).toBe(true)
    expect(key.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("abX\ncd")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("replace mode keeps appending before newline", () => {
    const ctx = createHandler("ab\ncd", { mode: "replace" })
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("X").event)
    ctx.handler.handleKey(createEvent("Y").event)

    expect(ctx.textarea.plainText).toBe("abXY\ncd")
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("replace mode appends at end of buffer", () => {
    const ctx = createHandler("ab", { mode: "replace" })
    ctx.textarea.cursorOffset = 2

    expect(ctx.handler.handleKey(createEvent("X").event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("abX")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("escape from replace mode moves cursor back like vim", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("R").event)
    ctx.handler.handleKey(createEvent("X").event)
    ctx.handler.handleKey(createEvent("Y").event)
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("aXYd")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("escape from replace mode without edits keeps cursor in place", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("R").event)
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("abcd")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("escape after appending at line end lands on last inserted char", () => {
    const ctx = createHandler("ab\ncd")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("R").event)
    ctx.handler.handleKey(createEvent("X").event)
    ctx.handler.handleKey(createEvent("Y").event)
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("abXY\ncd")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("replace mode ignores modified printable keys", () => {
    const ctx = createHandler("abcd", { mode: "replace" })
    ctx.textarea.cursorOffset = 1

    const key = createEvent("X", { ctrl: true })
    expect(ctx.handler.handleKey(key.event)).toBe(false)
    expect(key.prevented()).toBe(false)
    expect(ctx.textarea.plainText).toBe("abcd")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("replace mode tracks replace session state", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("R").event)
    expect(ctx.state.replace()).toBe(1)
    expect(ctx.state.typed()).toBe(false)

    ctx.handler.handleKey(createEvent("X").event)
    expect(ctx.state.replace()).toBe(1)
    expect(ctx.state.typed()).toBe(true)

    ctx.handler.handleKey(createEvent("escape").event)
    expect(ctx.state.replace()).toBe(null)
    expect(ctx.state.typed()).toBe(false)
  })

  test("/ starts forward copy search and @ stays in normal mode without autocomplete", () => {
    const ctx = createHandler("abc", { mode: "normal" })

    const slash = createEvent("/")
    expect(ctx.handler.handleKey(slash.event)).toBe(true)
    expect(slash.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("copy")
    expect(ctx.copySearchCalls).toEqual(["forward"])

    const at = createEvent("@")
    expect(ctx.handler.handleKey(at.event)).toBe(true)
    expect(at.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("copy")
  })

  test("/ enters insert on empty input with autocomplete available when copy search is unavailable", () => {
    const ctx = createHandler("", {
      mode: "normal",
      autocomplete: () => false,
      copySearchAvailable: false,
    })
    const slash = createEvent("/")

    expect(ctx.handler.handleKey(slash.event)).toBe(true)
    expect(slash.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("/")
    expect(ctx.copySearchCalls).toHaveLength(0)
  })

  test("@ enters insert on empty input with autocomplete available", () => {
    const ctx = createHandler("", {
      mode: "normal",
      autocomplete: () => false,
    })
    const at = createEvent("@")

    expect(ctx.handler.handleKey(at.event)).toBe(true)
    expect(at.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("@")
  })

  test("/ starts forward copy search when OpenTUI reports the key name as slash", () => {
    const ctx = createHandler("", {
      mode: "normal",
      autocomplete: () => false,
    })
    const slash = createEvent("slash")

    expect(ctx.handler.handleKey(slash.event)).toBe(true)
    expect(slash.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("copy")
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.copySearchCalls).toEqual(["forward"])
  })

  test("@ enters insert when OpenTUI reports the shifted base key", () => {
    const ctx = createHandler("", {
      mode: "normal",
      autocomplete: () => false,
    })
    const at = createEvent("2", { shift: true, sequence: "@" })

    expect(ctx.handler.handleKey(at.event)).toBe(true)
    expect(at.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("@")
  })

  test("/ starts copy search on non-empty input with autocomplete visible", () => {
    const ctx = createHandler("abc", {
      mode: "normal",
      autocomplete: () => "/",
    })
    const slash = createEvent("/")

    expect(ctx.handler.handleKey(slash.event)).toBe(true)
    expect(slash.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("copy")
    expect(ctx.copySearchCalls).toEqual(["forward"])
  })

  test("submit from normal keeps mode and clears pending", () => {
    let calls = 0
    const ctx = createHandler("", {
      mode: "normal",
      submit() {
        calls++
      },
    })
    ctx.state.setPending("d")

    ctx.handler.handleKey(createEvent("return").event)

    expect(calls).toBe(1)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.pending()).toBe("")
  })

  test("vim disabled does not intercept keys", () => {
    const ctx = createHandler("abc", { enabled: false })
    const keys = [
      createEvent("h"),
      createEvent("x"),
      createEvent("d"),
      createEvent("g"),
      createEvent("d", { ctrl: true }),
    ]

    for (const key of keys) {
      expect(ctx.handler.handleKey(key.event)).toBe(false)
      expect(key.prevented()).toBe(false)
    }

    expect(ctx.scrollCalls.length).toBe(0)
    expect(ctx.jumpCalls.length).toBe(0)
  })

  test("dd deletes current line", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    const d1 = createEvent("d")
    expect(ctx.handler.handleKey(d1.event)).toBe(true)
    expect(d1.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("d")

    const d2 = createEvent("d")
    expect(ctx.handler.handleKey(d2.event)).toBe(true)
    expect(d2.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\nthree")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
  })

  test("dd on last line lands at resulting line start", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 5

    expect(ctx.handler.handleKey(createEvent("d").event)).toBe(true)
    expect(ctx.handler.handleKey(createEvent("d").event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("one")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("dj deletes current and next line", () => {
    const ctx = createHandler("one\ntwo\nthree\nfour")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("j")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\nfour")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two\nthree", linewise: true })
  })

  test("dk deletes previous and current line", () => {
    const ctx = createHandler("one\ntwo\nthree\nfour")
    ctx.textarea.cursorOffset = 11

    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("k")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\nfour")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two\nthree", linewise: true })
  })

  test("counted dj deletes through target line", () => {
    const ctx = createHandler("one\ntwo\nthree\nfour\nfive")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("j")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\nfive")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two\nthree\nfour", linewise: true })
  })

  test("operator-pending counted dj deletes through target line", () => {
    const ctx = createHandler("one\ntwo\nthree\nfour\nfive")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("2").event)
    const motion = createEvent("j")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\nfive")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two\nthree\nfour", linewise: true })
  })

  test("operator-pending counted ck changes through target line", () => {
    const ctx = createHandler("one\ntwo\nthree\nfour\nfive")
    ctx.textarea.cursorOffset = 15

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("2").event)
    const motion = createEvent("k")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\n\nfive")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two\nthree\nfour", linewise: true })
  })

  test("dgj deletes display-line motion charwise", () => {
    const ctx = createHandler("abc\ndef\nghi")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("g").event)
    const motion = createEvent("j")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("aef\nghi")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "bc\nd", linewise: false })
  })

  test("operator display-line pending indicator shows full command", () => {
    const ctx = createHandler("abc\ndef")

    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.state.pending()).toBe("d")
    expect(ctx.state.pendingDisplay()).toBe("d")

    ctx.handler.handleKey(createEvent("g").event)
    expect(ctx.state.pending()).toBe("g")
    expect(ctx.state.pendingDisplay()).toBe("dg")
  })

  test("dgk deletes display-line motion charwise backward", () => {
    const ctx = createHandler("abc\ndef\nghi")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("g").event)
    const motion = createEvent("k")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("aef\nghi")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "bc\nd", linewise: false })
  })

  test("ygk yanks display-line motion charwise and moves to target", () => {
    const ctx = createHandler("abc\ndef\nghi")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("g").event)
    const motion = createEvent("k")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("abc\ndef\nghi")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "bc\nd", linewise: false })
  })

  test("ygj yanks display-line motion linewise at line start", () => {
    const ctx = createHandler("aa\nbb\ncc")

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.plainText).toBe("aa\nbb\ncc")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "aa", linewise: true })
  })

  test("cgj changes display-line motion linewise at line start", () => {
    const ctx = createHandler("aa\nbb\ncc")

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("g").event)
    const motion = createEvent("j")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("\nbb\ncc")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "aa", linewise: true })
  })

  test("cgj changes display-line motion charwise", () => {
    const ctx = createHandler("abc\ndef\nghi")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("g").event)
    const motion = createEvent("j")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("aef\nghi")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "bc\nd", linewise: false })
  })

  test("operator display-line motions support counts", () => {
    const ctx = createHandler("a\nb\nc\nd")

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.plainText).toBe("c\nd")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "a\nb", linewise: true })
  })

  test("operator-pending counts apply to display-line motions", () => {
    const ctx = createHandler("a\nb\nc\nd")

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.plainText).toBe("c\nd")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "a\nb", linewise: true })
  })

  test("operator display-line motions support arrow aliases", () => {
    const ctx = createHandler("abc\ndef")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("down").event)

    expect(ctx.textarea.plainText).toBe("aef")
    expect(ctx.state.register()).toEqual({ text: "bc\nd", linewise: false })
  })

  test("cancelled operator display-line motion clears pending count", () => {
    const ctx = createHandler("a\nb\nc\nd")

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("escape").event)
    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.plainText).toBe("c\nd")
    expect(ctx.state.register()).toEqual({ text: "a\nb", linewise: true })
  })

  test("yk yanks previous and current line", () => {
    const ctx = createHandler("one\ntwo\nthree\nfour")
    ctx.textarea.cursorOffset = 11

    ctx.handler.handleKey(createEvent("y").event)
    const motion = createEvent("k")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\ntwo\nthree\nfour")
    expect(ctx.textarea.cursorOffset).toBe(11)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two\nthree", linewise: true })
  })

  test("cj changes current and next line", () => {
    const ctx = createHandler("one\ntwo\nthree\nfour")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("c").event)
    const motion = createEvent("j")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\n\nfour")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two\nthree", linewise: true })
  })

  test("dk at first line is a no-op", () => {
    const ctx = createHandler("one\ntwo")

    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("k")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("one\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toBeNull()
  })

  test("d$ deletes to end of line", () => {
    const ctx = createHandler("one\ntwo three\nfour")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("$")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\nt\nfour")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "wo three", linewise: false })
  })

  test("counted d$ deletes through target line end", () => {
    const ctx = createHandler("one\ntwo three\nfour")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("$")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\nt")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "wo three\nfour", linewise: false })
  })

  test("d$ at end of line is no-op", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.pending()).toBe("")
  })

  test("d0 deletes to beginning of line", () => {
    const ctx = createHandler("one\ntwo three\nfour")
    ctx.textarea.cursorOffset = 9

    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("0")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\nhree\nfour")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two t", linewise: false })
  })

  test("d0 at beginning of line is no-op", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("0").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
  })

  test("d^ deletes back to first non-whitespace", () => {
    const ctx = createHandler("one\n  two three")
    ctx.textarea.cursorOffset = 10

    ctx.handler.handleKey(createEvent("d").event)
    const motion = createEvent("^")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\n  three")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two ", linewise: false })
  })

  test("d^ deletes forward to first non-whitespace", () => {
    const ctx = createHandler("one\n  two")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("^").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "  ", linewise: false })
  })

  test("dw deletes to next word and clears pending", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 0

    const d = createEvent("d")
    expect(ctx.handler.handleKey(d.event)).toBe(true)
    expect(ctx.state.pending()).toBe("d")

    const w = createEvent("w")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(w.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("world test")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
  })

  test("dw at last word deletes to end", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("dw stops before trailing punctuation", () => {
    const ctx = createHandler("changed?")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.textarea.plainText).toBe("?")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "changed", linewise: false })
  })

  test("dW deletes through next big word start", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    const w = createEvent("W")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(w.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("baz")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "foo.bar ", linewise: false })
  })

  test("dW at final big word deletes to end", () => {
    const ctx = createHandler("foo.bar")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("W").event)
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "foo.bar", linewise: false })
  })

  test("dW handles lowercase shifted key events", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("w", { shift: true }).event)
    expect(ctx.textarea.plainText).toBe("baz")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "foo.bar ", linewise: false })
  })

  test("db deletes to current word start", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.plainText).toBe("hello rld test")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.pending()).toBe("")
  })

  test("db at start of text is no-op", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("cb deletes to current word start and enters insert", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.plainText).toBe("hello rld test")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
  })

  test("cb at start of text does not delete text", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
  })

  test("db with register captures deleted text", () => {
    let reg = null as { text: string; linewise: boolean } | null
    const ctx = createHandler("hello world test", {
      register: {
        set(next) {
          reg = next
        },
      },
    })
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(reg).toEqual({ text: "wo", linewise: false })
  })

  test("diw deletes inner word", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello  test")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.register()).toEqual({ text: "world", linewise: false })
    expect(ctx.state.pending()).toBe("")
  })

  test("ciw changes inner word", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello  test")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "world", linewise: false })
  })

  test("diw deletes punctuation text object", () => {
    const ctx = createHandler("foo...bar")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("foobar")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.register()).toEqual({ text: "...", linewise: false })
  })

  test("caw changes punctuation and following whitespace", () => {
    const ctx = createHandler("foo... bar")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("foobar")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "... ", linewise: false })
  })

  test("daw deletes word and following whitespace", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello test")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.register()).toEqual({ text: "world ", linewise: false })
  })

  test("daw deletes leading whitespace for the final word", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toEqual({ text: " world", linewise: false })
  })

  test("caw changes word and following whitespace", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello test")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "world ", linewise: false })
  })

  test("yiw yanks inner word", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello world test")
    expect(ctx.state.register()).toEqual({ text: "world", linewise: false })
  })

  test("diw deletes middle whitespace run", () => {
    const ctx = createHandler("hello   world")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("helloworld")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toEqual({ text: "   ", linewise: false })
  })

  test("diw deletes trailing whitespace run", () => {
    const ctx = createHandler("hello world    ")
    ctx.textarea.cursorOffset = 12

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.textarea.cursorOffset).toBe(11)
    expect(ctx.state.register()).toEqual({ text: "    ", linewise: false })
  })

  test("ciw changes trailing whitespace run", () => {
    const ctx = createHandler("hello world    ")
    ctx.textarea.cursorOffset = 12

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.textarea.cursorOffset).toBe(11)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "    ", linewise: false })
  })

  test("diw deletes trailing whitespace run before line end", () => {
    const ctx = createHandler("hello    \nworld")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello\nworld")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toEqual({ text: "    ", linewise: false })
  })

  test("diw on newline does not join lines", () => {
    const ctx = createHandler("hello\nworld")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello\nworld")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toBeNull()
  })

  test("ciw on newline does not enter insert", () => {
    const ctx = createHandler("hello\nworld")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello\nworld")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toBeNull()
  })

  test("yiw on newline does not yank", () => {
    const ctx = createHandler("hello\nworld")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello\nworld")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toBeNull()
  })

  test("yiw yanks trailing whitespace run", () => {
    const ctx = createHandler("hello world    ")
    ctx.textarea.cursorOffset = 12

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello world    ")
    expect(ctx.state.register()).toEqual({ text: "    ", linewise: false })
  })

  test("yaw yanks word and following whitespace", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello world test")
    expect(ctx.state.register()).toEqual({ text: "world ", linewise: false })
  })

  test("daw deletes middle whitespace with following word", () => {
    const ctx = createHandler("hello   world test")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hellotest")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toEqual({ text: "   world ", linewise: false })
  })

  test("daw does not delete newline after word", () => {
    const ctx = createHandler("hello\nworld")

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("\nworld")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("daw does not delete newline before word", () => {
    const ctx = createHandler("hello\n   world")
    ctx.textarea.cursorOffset = 9

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(ctx.textarea.plainText).toBe("hello\n")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.register()).toEqual({ text: "   world", linewise: false })
  })

  test("diW deletes inner big word", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("W").event)

    expect(ctx.textarea.plainText).toBe(" baz")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "foo.bar", linewise: false })
  })

  test("ciW changes inner big word", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("W").event)

    expect(ctx.textarea.plainText).toBe(" baz")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "foo.bar", linewise: false })
  })

  test("daW deletes big word and following whitespace", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("W").event)

    expect(ctx.textarea.plainText).toBe("baz")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "foo.bar ", linewise: false })
  })

  test("yiW yanks inner big word", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("W").event)

    expect(ctx.textarea.plainText).toBe("foo.bar baz")
    expect(ctx.state.register()).toEqual({ text: "foo.bar", linewise: false })
  })

  test("yaW yanks big word and following whitespace", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("W").event)

    expect(ctx.textarea.plainText).toBe("foo.bar baz")
    expect(ctx.state.register()).toEqual({ text: "foo.bar ", linewise: false })
  })

  test("diW handles lowercase shifted key events", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("w", { shift: true }).event)

    expect(ctx.textarea.plainText).toBe(" baz")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "foo.bar", linewise: false })
  })

  test("di double quote deletes inside quotes", () => {
    const ctx = createHandler('say "hello" now')
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('say "" now')
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("ca double quote changes around quotes", () => {
    const ctx = createHandler('say "hello" now')
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe("say now")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: '"hello" ', linewise: false })
  })

  test("yi single quote yanks inside quotes", () => {
    const ctx = createHandler("say 'hello' now")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("'").event)

    expect(ctx.textarea.plainText).toBe("say 'hello' now")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("da backtick deletes around quotes", () => {
    const ctx = createHandler("say `hello` now")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("`").event)

    expect(ctx.textarea.plainText).toBe("say now")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.register()).toEqual({ text: "`hello` ", linewise: false })
  })

  test("quote text object selects later pair from opening quote", () => {
    const ctx = createHandler('"a" "b"')
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('"a" ""')
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toEqual({ text: "b", linewise: false })
  })

  test("di double quote deletes empty inner quote text", () => {
    const ctx = createHandler('say "" now')
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('say "" now')
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toEqual({ text: "", linewise: false })
  })

  test("ci double quote changes empty inner quote text", () => {
    const ctx = createHandler('say "" now')
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('say "" now')
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "", linewise: false })
  })

  test("ci double quote from opening empty quote enters between quotes", () => {
    const ctx = createHandler('say "" now')
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('say "" now')
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "", linewise: false })
  })

  test("da double quote deletes around quotes and trailing whitespace", () => {
    const ctx = createHandler('say "hello" now')
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe("say now")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.register()).toEqual({ text: '"hello" ', linewise: false })
  })

  test("da double quote deletes around quotes and leading whitespace at line end", () => {
    const ctx = createHandler('say "hello"')
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe("say")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.register()).toEqual({ text: ' "hello"', linewise: false })
  })

  test("ya double quote yanks around quotes and trailing whitespace", () => {
    const ctx = createHandler('say "hello" now')
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('say "hello" now')
    expect(ctx.state.register()).toEqual({ text: '"hello" ', linewise: false })
  })

  test("quote text object selects surrounding quotes between pairs", () => {
    const ctx = createHandler('"a" "b"')
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)
    ctx.textarea.insertText("X")

    expect(ctx.textarea.plainText).toBe('"a"X"b"')
    expect(ctx.state.register()).toEqual({ text: " ", linewise: false })
  })

  test("quote text object ignores escaped quotes", () => {
    const ctx = createHandler('say "hello \\"world\\"" now')
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('say "" now')
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: 'hello \\"world\\"', linewise: false })
  })

  test("quote text object handles astral Unicode before quotes", () => {
    const ctx = createHandler('🙂 "hello" now')
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('🙂 "" now')
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("quote text object treats double backslash quote as delimiter", () => {
    const ctx = createHandler('"a\\\\" "b"')
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('"" "b"')
    expect(ctx.state.register()).toEqual({ text: "a\\\\", linewise: false })
  })

  test("quote text object no-ops when pair is missing", () => {
    const ctx = createHandler('say "hello now')
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('say "hello now')
    expect(ctx.state.register()).toBeNull()
    expect(ctx.state.pending()).toBe("")
  })

  test("quote text object stays on current line", () => {
    const ctx = createHandler('say "hello\nworld" now')
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent('"').event)

    expect(ctx.textarea.plainText).toBe('say "hello\nworld" now')
    expect(ctx.state.register()).toBeNull()
  })

  test("quote text object normalizes named quote key", () => {
    const ctx = createHandler('say "hello" now')
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("quote", { sequence: '"' }).event)

    expect(ctx.textarea.plainText).toBe('say "" now')
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("di parenthesis deletes inside brackets", () => {
    const ctx = createHandler("say (hello) now")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("(").event)

    expect(ctx.textarea.plainText).toBe("say () now")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("ca square bracket changes around brackets", () => {
    const ctx = createHandler("say [hello] now")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("]").event)

    expect(ctx.textarea.plainText).toBe("say  now")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "[hello]", linewise: false })
  })

  test("yi curly bracket yanks inside brackets", () => {
    const ctx = createHandler("say {hello} now")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("}").event)

    expect(ctx.textarea.plainText).toBe("say {hello} now")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("da angle bracket deletes around brackets", () => {
    const ctx = createHandler("say <hello> now")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent(">").event)

    expect(ctx.textarea.plainText).toBe("say  now")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.register()).toEqual({ text: "<hello>", linewise: false })
  })

  test("bracket text object selects nested pair", () => {
    const ctx = createHandler("(a (b) c)")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("(").event)

    expect(ctx.textarea.plainText).toBe("(a () c)")
    expect(ctx.state.register()).toEqual({ text: "b", linewise: false })
  })

  test("bracket text object selects containing pair after nested pair", () => {
    const ctx = createHandler("(a (b) c)")
    ctx.textarea.cursorOffset = 7

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("(").event)

    expect(ctx.textarea.plainText).toBe("()")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "a (b) c", linewise: false })
  })

  test("bracket text object handles many unmatched openers", () => {
    const ctx = createHandler("(".repeat(500) + "hello")
    ctx.textarea.cursorOffset = 502

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("(").event)

    expect(ctx.textarea.plainText).toBe("(".repeat(500) + "hello")
    expect(ctx.state.register()).toBeNull()
    expect(ctx.state.pending()).toBe("")
  })

  test("ci parenthesis from opening empty pair enters between brackets", () => {
    const ctx = createHandler("say () now")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent(")").event)

    expect(ctx.textarea.plainText).toBe("say () now")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "", linewise: false })
  })

  test("bracket text object finds pair after cursor", () => {
    const ctx = createHandler("say before (hello) now")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("(").event)

    expect(ctx.textarea.plainText).toBe("say before () now")
    expect(ctx.textarea.cursorOffset).toBe(12)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("bracket text object no-ops after pair", () => {
    const ctx = createHandler("say (hello) now")
    ctx.textarea.cursorOffset = 12

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("(").event)

    expect(ctx.textarea.plainText).toBe("say (hello) now")
    expect(ctx.state.register()).toBeNull()
    expect(ctx.state.pending()).toBe("")
  })

  test("bracket text object spans multiple lines", () => {
    const ctx = createHandler("call(\n  hello\n)")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("(").event)

    expect(ctx.textarea.plainText).toBe("call(\n)")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.register()).toEqual({ text: "  hello\n", linewise: false })
  })

  test("change bracket text object spans multiple lines", () => {
    const ctx = createHandler("call(\n  hello\n)")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("(").event)

    expect(ctx.textarea.plainText).toBe("call(\n\n)")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "  hello\n", linewise: false })
  })

  test("yank around bracket text object spans multiple lines", () => {
    const ctx = createHandler("call(\n  hello\n)")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("a").event)
    ctx.handler.handleKey(createEvent("(").event)

    expect(ctx.textarea.plainText).toBe("call(\n  hello\n)")
    expect(ctx.state.register()).toEqual({ text: "(\n  hello\n)", linewise: false })
  })

  test("bracket text object normalizes shifted bracket key", () => {
    const ctx = createHandler("say {hello} now")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("[", { shift: true, sequence: "{" }).event)

    expect(ctx.textarea.plainText).toBe("say {} now")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("bracket text object normalizes shifted bracket key without sequence", () => {
    const ctx = createHandler("say {hello} now")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("[", { shift: true }).event)

    expect(ctx.textarea.plainText).toBe("say {} now")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("bracket text object normalizes shifted parenthesis key without sequence", () => {
    const ctx = createHandler("say (hello) now")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("9", { shift: true }).event)

    expect(ctx.textarea.plainText).toBe("say () now")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("text object pending display shows operator and object scope", () => {
    const ctx = createHandler("hello world")

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("i").event)

    expect(ctx.state.pending()).toBe("c")
    expect(ctx.state.pendingDisplay()).toBe("ci")
  })

  test("text object invalid target clears pending", () => {
    const ctx = createHandler("hello world")

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("i").event)
    const invalid = createEvent("x")
    expect(ctx.handler.handleKey(invalid.event)).toBe(true)
    expect(invalid.prevented()).toBe(true)

    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.pendingDisplay()).toBe("")
  })

  test("de deletes to end of word and clears pending", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 0

    const d = createEvent("d")
    expect(ctx.handler.handleKey(d.event)).toBe(true)
    expect(ctx.state.pending()).toBe("d")

    const e = createEvent("e")
    expect(ctx.handler.handleKey(e.event)).toBe(true)
    expect(e.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe(" world test")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
  })

  test("de from mid-word deletes to end of current word", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("he world")
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("de from whitespace deletes through next word", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("hello test")
    expect(ctx.textarea.cursorOffset).toBe(5)
  })

  test("de at last word deletes to end", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("de populates register", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("dE deletes through end of BIG word across punctuation", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    const e = createEvent("E")
    expect(ctx.handler.handleKey(e.event)).toBe(true)
    expect(e.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe(" baz")
    expect(ctx.state.register()).toEqual({ text: "foo.bar", linewise: false })
    expect(ctx.state.pending()).toBe("")
  })

  test("dE handles lowercase shifted key events", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e", { shift: true }).event)
    expect(ctx.textarea.plainText).toBe(" baz")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "foo.bar", linewise: false })
  })

  test("dE from mid big-word deletes to end of current big-word", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("E").event)
    expect(ctx.textarea.plainText).toBe("fo baz")
    expect(ctx.state.register()).toEqual({ text: "o.bar", linewise: false })
  })

  test("de at last char of buffer deletes that char", () => {
    const ctx = createHandler("one two")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("one tw")
    expect(ctx.state.register()).toEqual({ text: "o", linewise: false })
  })

  test("de past end of buffer is a no-op and clears pending", () => {
    const ctx = createHandler("hi")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("hi")
    expect(ctx.state.pending()).toBe("")
  })

  test("ce deletes to end of word and enters insert", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 0

    const c = createEvent("c")
    expect(ctx.handler.handleKey(c.event)).toBe(true)
    expect(ctx.state.pending()).toBe("c")

    const e = createEvent("e")
    expect(ctx.handler.handleKey(e.event)).toBe(true)
    expect(e.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe(" world test")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
  })

  test("ce from mid-word changes to end of current word", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("he world")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.mode()).toBe("insert")
  })

  test("ce populates register", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("cE changes through end of BIG word and enters insert", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("E").event)
    expect(ctx.textarea.plainText).toBe(" baz")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "foo.bar", linewise: false })
  })

  test("cE from mid big-word changes to end of current big-word", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("E").event)
    expect(ctx.textarea.plainText).toBe("fo baz")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "o.bar", linewise: false })
  })

  test("de from end of word deletes through punct cluster", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("fobar")
    expect(ctx.state.register()).toEqual({ text: "o!!!", linewise: false })
  })

  test("de from start of punct cluster deletes the cluster", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("foobar")
    expect(ctx.state.register()).toEqual({ text: "!!!", linewise: false })
  })

  test("de from mid punct cluster deletes to end of cluster", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("foo!bar")
    expect(ctx.state.register()).toEqual({ text: "!!", linewise: false })
  })

  test("de from end of punct cluster advances into next word", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("foo!!")
    expect(ctx.state.register()).toEqual({ text: "!bar", linewise: false })
  })

  test("de on punct surrounded by spaces deletes only cluster", () => {
    const ctx = createHandler("a !!! b")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("a ! b")
    expect(ctx.state.register()).toEqual({ text: "!!", linewise: false })
  })

  test("de on trailing punct deletes the punct", () => {
    const ctx = createHandler("hello!")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("hello")
    expect(ctx.state.register()).toEqual({ text: "!", linewise: false })
  })

  test("ce on punct cluster changes the cluster", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("foobar")
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "!!!", linewise: false })
  })

  test("ye yanks punct cluster only", () => {
    const ctx = createHandler("foo!!!bar")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.textarea.plainText).toBe("foo!!!bar")
    expect(ctx.state.register()).toEqual({ text: "!!!", linewise: false })
  })

  test("cb with register captures deleted text", () => {
    let reg = null as { text: string; linewise: boolean } | null
    const ctx = createHandler("hello world test", {
      register: {
        set(next) {
          reg = next
        },
      },
    })
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(reg).toEqual({ text: "wo", linewise: false })
  })

  test("J joins current line with next", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 1

    const j = createEvent("J")
    expect(ctx.handler.handleKey(j.event)).toBe(true)
    expect(j.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.textarea.plainText).toBe("one two\nthree")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("J strips leading whitespace on next line", () => {
    const ctx = createHandler("one\n  two")
    ctx.textarea.cursorOffset = 0

    const j = createEvent("J")
    expect(ctx.handler.handleKey(j.event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("one two")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("J on last line is a no-op", () => {
    const ctx = createHandler("only line")
    ctx.textarea.cursorOffset = 2

    const j = createEvent("J")
    expect(ctx.handler.handleKey(j.event)).toBe(true)
    expect(j.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("only line")
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("J with empty next line", () => {
    const ctx = createHandler("one\n\nthree")
    ctx.textarea.cursorOffset = 0

    const j = createEvent("J")
    expect(ctx.handler.handleKey(j.event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("one \nthree")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("J strips tab indentation on next line", () => {
    const ctx = createHandler("one\n\t\ttwo")
    ctx.textarea.cursorOffset = 0

    const j = createEvent("J")
    expect(ctx.handler.handleKey(j.event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("one two")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("J skips space when current line has trailing whitespace", () => {
    const ctx = createHandler("one \ntwo")
    ctx.textarea.cursorOffset = 0

    const j = createEvent("J")
    expect(ctx.handler.handleKey(j.event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("one two")
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("J skips space when next line starts with )", () => {
    const ctx = createHandler("foo(\n)")
    ctx.textarea.cursorOffset = 0

    const j = createEvent("J")
    expect(ctx.handler.handleKey(j.event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("foo()")
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("f finds character forward", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("f").event)
    expect(ctx.state.pending()).toBe("f")

    const o = createEvent("o")
    expect(ctx.handler.handleKey(o.event)).toBe(true)
    expect(o.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
  })

  test("F finds character backward", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("F").event)
    expect(ctx.state.pending()).toBe("F")

    const o = createEvent("o")
    expect(ctx.handler.handleKey(o.event)).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(7)
  })

  test("f not found stays put", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("z").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("f stays on current line", () => {
    const ctx = createHandler("abc\ndef")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("f clears pending after char", () => {
    const ctx = createHandler("abcabc")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("f").event)
    expect(ctx.state.pending()).toBe("f")
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.state.pending()).toBe("")
  })

  test("f pending clears on escape", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("f").event)
    expect(ctx.state.pending()).toBe("f")
    ctx.handler.handleKey(createEvent("escape").event)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("; repeats last find forward", () => {
    const ctx = createHandler("abcabc")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.cursorOffset).toBe(1)

    ctx.handler.handleKey(createEvent(";").event)
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test(", repeats last find in reverse", () => {
    const ctx = createHandler("abcabc")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.cursorOffset).toBe(1)

    ctx.handler.handleKey(createEvent(";").event)
    expect(ctx.textarea.cursorOffset).toBe(4)

    const comma = createEvent(",")
    expect(ctx.handler.handleKey(comma.event)).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("; with no previous find is no-op", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 2

    const semi = createEvent(";")
    expect(ctx.handler.handleKey(semi.event)).toBe(true)
    expect(semi.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("F then ; repeats backward", () => {
    const ctx = createHandler("abcabc")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("F").event)
    ctx.handler.handleKey(createEvent("a").event)
    expect(ctx.textarea.cursorOffset).toBe(3)

    ctx.handler.handleKey(createEvent(";").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("t stops one before target", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("t").event)
    expect(ctx.state.pending()).toBe("t")

    const o = createEvent("o")
    expect(ctx.handler.handleKey(o.event)).toBe(true)
    expect(o.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.pending()).toBe("")
  })

  test("T stops one after target backward", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("T").event)
    expect(ctx.state.pending()).toBe("T")

    const o = createEvent("o")
    expect(ctx.handler.handleKey(o.event)).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(8)
  })

  test("t not found stays put", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("t").event)
    ctx.handler.handleKey(createEvent("z").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("t stays on current line", () => {
    const ctx = createHandler("abc\ndef")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("t").event)
    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("; after t repeats as till", () => {
    const ctx = createHandler("axbxbx")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("t").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.cursorOffset).toBe(1)

    ctx.handler.handleKey(createEvent(";").event)
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test(", after t reverses as till", () => {
    const ctx = createHandler("axbxxbxc")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("t").event)
    ctx.handler.handleKey(createEvent("b").event)
    expect(ctx.textarea.cursorOffset).toBe(1)

    ctx.handler.handleKey(createEvent(";").event)
    expect(ctx.textarea.cursorOffset).toBe(4)

    ctx.handler.handleKey(createEvent(",").event)
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("f finds uppercase char forward", () => {
    const ctx = createHandler("Hello World")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("f").event)
    expect(ctx.state.pending()).toBe("f")

    const w = createEvent("W")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(w.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.pending()).toBe("")
  })

  test("F finds uppercase char backward", () => {
    const ctx = createHandler("Hello World")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("F").event)
    expect(ctx.state.pending()).toBe("F")

    const w = createEvent("W")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(6)
  })

  test("t stops before uppercase char", () => {
    const ctx = createHandler("Hello World")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("t").event)
    expect(ctx.state.pending()).toBe("t")

    const w = createEvent("W")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(w.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.pending()).toBe("")
  })

  test("T stops after uppercase char backward", () => {
    const ctx = createHandler("Hello World")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("T").event)
    expect(ctx.state.pending()).toBe("T")

    const w = createEvent("W")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(7)
  })

  test("pending find treats G as target char instead of jump", () => {
    const ctx = createHandler("abGcdGef")

    ctx.handler.handleKey(createEvent("f").event)
    expect(ctx.handler.handleKey(createEvent("G").event)).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.jumpCalls).toEqual([])

    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("t").event)
    expect(ctx.handler.handleKey(createEvent("G").event)).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.jumpCalls).toEqual([])

    ctx.textarea.cursorOffset = 7
    ctx.handler.handleKey(createEvent("F").event)
    expect(ctx.handler.handleKey(createEvent("G").event)).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.jumpCalls).toEqual([])

    ctx.textarea.cursorOffset = 7
    ctx.handler.handleKey(createEvent("T").event)
    expect(ctx.handler.handleKey(createEvent("G").event)).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.jumpCalls).toEqual([])
  })

  test("pending find normalizes slash target", () => {
    const ctx = createHandler("ab/cd")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("f").event)
    const slash = createEvent("slash")
    expect(ctx.handler.handleKey(slash.event)).toBe(true)
    expect(slash.prevented()).toBe(true)
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.lastFind()).toEqual({ char: "/", forward: true, till: false })
    expect(ctx.state.pending()).toBe("")
  })

  test("df normalizes slash target", () => {
    const ctx = createHandler("ab/cd")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("f").event)
    const slash = createEvent("slash")
    expect(ctx.handler.handleKey(slash.event)).toBe(true)
    expect(slash.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("cd")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "ab/", linewise: false })
    expect(ctx.state.lastFind()).toEqual({ char: "/", forward: true, till: false })
    expect(ctx.state.pending()).toBe("")
  })

  test("cf normalizes at target", () => {
    const ctx = createHandler("ab@cd")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("f").event)
    const at = createEvent("at")
    expect(ctx.handler.handleKey(at.event)).toBe(true)
    expect(at.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("cd")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "ab@", linewise: false })
    expect(ctx.state.lastFind()).toEqual({ char: "@", forward: true, till: false })
  })

  test("df deletes forward including found char", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("f").event)
    expect(ctx.state.pending()).toBe("f")
    expect(ctx.state.pendingDisplay()).toBe("df")

    const o = createEvent("o")
    expect(ctx.handler.handleKey(o.event)).toBe(true)
    expect(o.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe(" world")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
    expect(ctx.state.pending()).toBe("")
  })

  test("dF deletes backward including found char and excluding cursor", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("F").event)
    expect(ctx.state.pending()).toBe("F")

    const o = createEvent("o")
    expect(ctx.handler.handleKey(o.event)).toBe(true)
    expect(o.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("hello wrld")
    expect(ctx.textarea.cursorOffset).toBe(7)
    expect(ctx.state.register()).toEqual({ text: "o", linewise: false })
    expect(ctx.state.pending()).toBe("")
  })

  test("dt deletes forward up to found char", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("t").event)
    expect(ctx.state.pending()).toBe("t")

    const o = createEvent("o")
    expect(ctx.handler.handleKey(o.event)).toBe(true)
    expect(o.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("o world")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "hell", linewise: false })
    expect(ctx.state.pending()).toBe("")
  })

  test("dT deletes backward from after found char and excludes cursor", () => {
    const ctx = createHandler("abcxdefgh")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("T").event)
    expect(ctx.state.pending()).toBe("T")

    const x = createEvent("x")
    expect(ctx.handler.handleKey(x.event)).toBe(true)
    expect(x.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("abcxfgh")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.register()).toEqual({ text: "de", linewise: false })
    expect(ctx.state.pending()).toBe("")
  })

  test("df not found leaves text unchanged", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("z").event)
    expect(ctx.textarea.plainText).toBe("hello")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
  })

  test("df not found preserves register", () => {
    const ctx = createHandler("hello")
    ctx.state.setRegister({ text: "kept", linewise: false })
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("z").event)
    expect(ctx.state.register()).toEqual({ text: "kept", linewise: false })
  })

  test("df handles uppercase target char", () => {
    const ctx = createHandler("hello World")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("W").event)
    expect(ctx.textarea.plainText).toBe("orld")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.register()).toEqual({ text: "hello W", linewise: false })
  })

  test("df ignores stale operator find after pending is cleared", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("f").event)
    ctx.state.clearPending()

    ctx.handler.handleKey(createEvent("G").event)
    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.jumpCalls).toEqual(["bottom"])
  })

  test("df undo restores original cursor", () => {
    const ctx = createHandler("abc def ghi")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("t").event)
    ctx.handler.handleKey(createEvent("f").event)
    expect(ctx.textarea.plainText).toBe("f ghi")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("abc def ghi")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("df stays on current line", () => {
    const ctx = createHandler("abc\ndef")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.plainText).toBe("abc\ndef")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("dF stays on current line", () => {
    const ctx = createHandler("abc\nxdef")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("F").event)
    ctx.handler.handleKey(createEvent("c").event)
    expect(ctx.textarea.plainText).toBe("abc\nxdef")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.pending()).toBe("")
  })

  test("dF at start of buffer ignores current char", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("F").event)
    ctx.handler.handleKey(createEvent("a").event)
    expect(ctx.textarea.plainText).toBe("abc")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
  })

  test("dT stays on current line", () => {
    const ctx = createHandler("abc\nxdef")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("T").event)
    ctx.handler.handleKey(createEvent("c").event)
    expect(ctx.textarea.plainText).toBe("abc\nxdef")
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect(ctx.state.pending()).toBe("")
  })

  test("dT adjacent target is a no-op", () => {
    const ctx = createHandler("ab")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("T").event)
    ctx.handler.handleKey(createEvent("a").event)
    expect(ctx.textarea.plainText).toBe("ab")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.pending()).toBe("")
  })

  test("df cancels pending operator find on modified target", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("f").event)

    const x = createEvent("x", { ctrl: true })
    expect(ctx.handler.handleKey(x.event)).toBe(true)
    expect(x.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.pending()).toBe("")
  })

  test("dot repeats df from current cursor", () => {
    const ctx = createHandler("a-b-c")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("-").event)
    expect(ctx.textarea.plainText).toBe("b-c")

    ctx.handler.handleKey(createEvent(".").event)
    expect(ctx.textarea.plainText).toBe("c")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("cf changes forward including found char", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("f").event)
    expect(ctx.state.pending()).toBe("f")
    expect(ctx.state.pendingDisplay()).toBe("cf")

    const o = createEvent("o")
    expect(ctx.handler.handleKey(o.event)).toBe(true)
    expect(o.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe(" world")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
    expect(ctx.state.pending()).toBe("")
  })

  test("cF changes backward including found char and excluding cursor", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 8

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("F").event)
    expect(ctx.state.pendingDisplay()).toBe("cF")

    const o = createEvent("o")
    expect(ctx.handler.handleKey(o.event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("hello wrld")
    expect(ctx.textarea.cursorOffset).toBe(7)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "o", linewise: false })
  })

  test("ct changes forward up to found char", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("t").event)
    expect(ctx.state.pendingDisplay()).toBe("ct")

    const o = createEvent("o")
    expect(ctx.handler.handleKey(o.event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("o world")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "hell", linewise: false })
  })

  test("cT changes backward from after found char and excludes cursor", () => {
    const ctx = createHandler("abcxdefgh")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("T").event)
    expect(ctx.state.pendingDisplay()).toBe("cT")

    const x = createEvent("x")
    expect(ctx.handler.handleKey(x.event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("abcxfgh")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "de", linewise: false })
  })

  test("cf not found leaves mode and register unchanged", () => {
    const ctx = createHandler("hello")
    ctx.state.setRegister({ text: "kept", linewise: false })
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("z").event)
    expect(ctx.textarea.plainText).toBe("hello")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "kept", linewise: false })
    expect(ctx.state.pending()).toBe("")
  })

  test("cT adjacent target is a no-op", () => {
    const ctx = createHandler("ab")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("T").event)
    ctx.handler.handleKey(createEvent("a").event)
    expect(ctx.textarea.plainText).toBe("ab")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.pending()).toBe("")
  })

  test("dot repeats cf inserted text", () => {
    const ctx = createHandler("a-b-c")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("f").event)
    ctx.handler.handleKey(createEvent("-").event)
    ctx.textarea.insertText("x")
    ctx.handler.handleKey(createEvent("escape").event)
    expect(ctx.textarea.plainText).toBe("xb-c")

    ctx.textarea.cursorOffset = 1
    ctx.handler.handleKey(createEvent(".").event)
    expect(ctx.textarea.plainText).toBe("xxc")
  })

  test("yy yanks current line into register", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("y").event)
    expect(ctx.state.pending()).toBe("y")

    ctx.handler.handleKey(createEvent("y").event)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two", linewise: true })
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.textarea.plainText).toBe("one\ntwo\nthree")
  })

  test("counted yy yanks multiple lines into register", () => {
    const ctx = createHandler("one\ntwo\nthree\nfour")

    ctx.handler.handleKey(createEvent("3").event)
    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("y").event)

    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo\nthree", linewise: true })
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.textarea.plainText).toBe("one\ntwo\nthree\nfour")
  })

  test("yy flashes current line span", () => {
    const spans: Array<{ start: number; end: number }> = []
    const ctx = createHandler("one\ntwo\nthree", {
      flash(span) {
        spans.push(span)
      },
    })
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("y").event)

    expect(spans).toEqual([{ start: 4, end: 7 }])
  })

  test("y$ yanks to end of line", () => {
    const ctx = createHandler("one\ntwo three\nfour")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("y").event)
    const motion = createEvent("$")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\ntwo three\nfour")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "wo three", linewise: false })
  })

  test("counted y$ yanks through target line end", () => {
    const ctx = createHandler("one\ntwo three\nfour")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("y").event)
    const motion = createEvent("$")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\ntwo three\nfour")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "wo three\nfour", linewise: false })
  })

  test("y$ at end of line is no-op", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toBeNull()
  })

  test("y0 yanks to beginning of line", () => {
    const ctx = createHandler("one\ntwo three\nfour")
    ctx.textarea.cursorOffset = 9

    ctx.handler.handleKey(createEvent("y").event)
    const motion = createEvent("0")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\ntwo three\nfour")
    expect(ctx.textarea.cursorOffset).toBe(9)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two t", linewise: false })
  })

  test("y0 at beginning of line is no-op", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("0").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toBeNull()
  })

  test("y^ yanks back to first non-whitespace", () => {
    const ctx = createHandler("one\n  two three")
    ctx.textarea.cursorOffset = 10

    ctx.handler.handleKey(createEvent("y").event)
    const motion = createEvent("^")
    expect(ctx.handler.handleKey(motion.event)).toBe(true)
    expect(motion.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\n  two three")
    expect(ctx.textarea.cursorOffset).toBe(10)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "two ", linewise: false })
  })

  test("y^ yanks forward to first non-whitespace", () => {
    const ctx = createHandler("one\n  two")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("^").event)
    expect(ctx.textarea.plainText).toBe("one\n  two")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "  ", linewise: false })
  })

  test("yw yanks word into register", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.state.register()).toEqual({ text: "hello ", linewise: false })
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.textarea.plainText).toBe("hello world")
  })

  test("yw stops before trailing punctuation", () => {
    const ctx = createHandler("changed?")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.state.register()).toEqual({ text: "changed", linewise: false })
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.textarea.plainText).toBe("changed?")
  })

  test("yW yanks through next big word start", () => {
    const ctx = createHandler("foo.bar baz")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    const w = createEvent("W")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(w.prevented()).toBe(true)
    expect(ctx.state.register()).toEqual({ text: "foo.bar ", linewise: false })
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.textarea.plainText).toBe("foo.bar baz")
    expect(ctx.state.pending()).toBe("")
  })

  test("yW flashes yanked big word span", () => {
    const spans: Array<{ start: number; end: number }> = []
    const ctx = createHandler("foo.bar baz", {
      flash(span) {
        spans.push(span)
      },
    })
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("W").event)

    expect(spans).toEqual([{ start: 0, end: 8 }])
  })

  test("yw flashes yanked word span", () => {
    const spans: Array<{ start: number; end: number }> = []
    const ctx = createHandler("hello world", {
      flash(span) {
        spans.push(span)
      },
    })
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("w").event)

    expect(spans).toEqual([{ start: 0, end: 6 }])
  })

  test("ye yanks to end of word into register", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    const y = createEvent("y")
    expect(ctx.handler.handleKey(y.event)).toBe(true)
    expect(ctx.state.pending()).toBe("y")

    const e = createEvent("e")
    expect(ctx.handler.handleKey(e.event)).toBe(true)
    expect(e.prevented()).toBe(true)
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.state.pending()).toBe("")
  })

  test("ye from mid-word yanks to end of current word", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("e").event)
    expect(ctx.state.register()).toEqual({ text: "llo", linewise: false })
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.textarea.plainText).toBe("hello world")
  })

  test("ye flashes yanked span", () => {
    const spans: Array<{ start: number; end: number }> = []
    const ctx = createHandler("hello world", {
      flash(span) {
        spans.push(span)
      },
    })
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("e").event)

    expect(spans).toEqual([{ start: 0, end: 5 }])
  })

  test("yE yanks through end of BIG word across punctuation", () => {
    const spans: Array<{ start: number; end: number }> = []
    const ctx = createHandler("foo.bar baz", {
      flash(span) {
        spans.push(span)
      },
    })
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("E").event)
    expect(ctx.state.register()).toEqual({ text: "foo.bar", linewise: false })
    expect(ctx.textarea.plainText).toBe("foo.bar baz")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(spans).toEqual([{ start: 0, end: 7 }])
  })

  test("yE from mid big-word yanks to end of current big-word", () => {
    const spans: Array<{ start: number; end: number }> = []
    const ctx = createHandler("foo.bar baz", {
      flash(span) {
        spans.push(span)
      },
    })
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("E").event)
    expect(ctx.state.register()).toEqual({ text: "o.bar", linewise: false })
    expect(ctx.textarea.plainText).toBe("foo.bar baz")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(spans).toEqual([{ start: 2, end: 7 }])
  })

  test("p pastes linewise below current line", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("y").event)

    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("one\none\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("P pastes linewise above current line", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("y").event)

    ctx.handler.handleKey(createEvent("P").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("p pastes characterwise after cursor", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("w").event)

    ctx.textarea.cursorOffset = 6
    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("hello whello orld")
    expect(ctx.textarea.cursorOffset).toBe(12)
  })

  test("uses custom register getter for paste", () => {
    const ctx = createHandler("abc", {
      register: {
        get() {
          return { text: "z", linewise: false }
        },
      },
    })

    expect(ctx.handler.handleKey(createEvent("p").event)).toBe(true)
    expect(ctx.textarea.plainText).toBe("azbc")
    expect(ctx.state.register()).toBe(null)
  })

  test("P pastes characterwise before cursor", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("w").event)

    ctx.textarea.cursorOffset = 6
    ctx.handler.handleKey(createEvent("P").event)
    expect(ctx.textarea.plainText).toBe("hello hello world")
    expect(ctx.textarea.cursorOffset).toBe(11)
  })

  test("p replaces highlighted prompt selection", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("w").event)

    ctx.textarea.editorView.setSelection(0, 5)
    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("world world")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("p ignores transient prompt selection when replacement is disabled", () => {
    const ctx = createHandler("one\ntwo", { pasteOverSelection: () => false })

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("y").event)

    ctx.textarea.editorView.setSelection(0, 3)
    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("one\none\ntwo")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.register()).toEqual({ text: "one", linewise: true })
  })

  test("p with empty register is no-op", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 2

    const p = createEvent("p")
    expect(ctx.handler.handleKey(p.event)).toBe(true)
    expect(p.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("hello")
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("yy then p multiple times", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("y").event)

    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("abc\nabc")

    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("abc\nabc\nabc")
  })

  test("dd populates register", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.state.register()).toEqual({ text: "two", linewise: true })
  })

  test("dw populates register", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.state.register()).toEqual({ text: "hello ", linewise: false })
  })

  test("x populates register", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("x").event)
    expect(ctx.state.register()).toEqual({ text: "b", linewise: false })
  })

  test("pending y clears on escape", () => {
    const ctx = createHandler("hello")

    ctx.handler.handleKey(createEvent("y").event)
    expect(ctx.state.pending()).toBe("y")

    ctx.handler.handleKey(createEvent("escape").event)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toBe(null)
  })

  test("pending y clears on invalid key", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("y").event)
    expect(ctx.state.pending()).toBe("y")

    ctx.handler.handleKey(createEvent("h").event)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("pending y clears on modifier key", () => {
    const ctx = createHandler("abc")

    ctx.handler.handleKey(createEvent("y").event)
    expect(ctx.state.pending()).toBe("y")

    const mod = createEvent("j", { ctrl: true })
    expect(ctx.handler.handleKey(mod.event)).toBe(false)
    expect(mod.prevented()).toBe(false)
    expect(ctx.state.pending()).toBe("")
  })

  test("dd then p pastes deleted line below", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.plainText).toBe("one\nthree")

    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("one\nthree\ntwo")
  })

  test("pending d clears on escape", () => {
    const ctx = createHandler("hello world")

    expect(ctx.handler.handleKey(createEvent("d").event)).toBe(true)
    expect(ctx.state.pending()).toBe("d")

    const esc = createEvent("escape")
    expect(ctx.handler.handleKey(esc.event)).toBe(true)
    expect(esc.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.textarea.plainText).toBe("hello world")
  })

  test("pending d clears on invalid key and key is handled normally", () => {
    const ctx = createHandler("abc")

    expect(ctx.handler.handleKey(createEvent("d").event)).toBe(true)
    expect(ctx.state.pending()).toBe("d")

    const q = createEvent("q")
    expect(ctx.handler.handleKey(q.event)).toBe(true)
    expect(q.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.mode()).toBe("normal")
  })

  test("mode switch clears pending state", () => {
    const ctx = createHandler("abc")
    expect(ctx.handler.handleKey(createEvent("d").event)).toBe(true)
    expect(ctx.state.pending()).toBe("d")

    expect(ctx.handler.handleKey(createEvent("o").event)).toBe(true)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")

    expect(ctx.handler.handleKey(createEvent("escape").event)).toBe(true)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.pending()).toBe("")

    const h = createEvent("h")
    expect(ctx.handler.handleKey(h.event)).toBe(true)
    expect(h.prevented()).toBe(true)
  })

  test("pending d clears on modifier key and event is not consumed", () => {
    const ctx = createHandler("abc")

    expect(ctx.handler.handleKey(createEvent("d").event)).toBe(true)
    expect(ctx.state.pending()).toBe("d")

    const mod = createEvent("j", { ctrl: true })
    expect(ctx.handler.handleKey(mod.event)).toBe(false)
    expect(mod.prevented()).toBe(false)
    expect(ctx.state.pending()).toBe("")
  })

  test("ctrl scroll keys trigger actions", () => {
    const ctx = createHandler("abc")
    const keys: Array<[string, VimScroll]> = [
      ["e", "line-down"],
      ["y", "line-up"],
      ["d", "half-down"],
      ["u", "half-up"],
      ["f", "page-down"],
      ["b", "page-up"],
    ]

    for (const [key, action] of keys) {
      const evt = createEvent(key, { ctrl: true })
      expect(ctx.handler.handleKey(evt.event)).toBe(true)
      expect(evt.prevented()).toBe(true)
      expect(ctx.scrollCalls.at(-1)).toBe(action)
    }
  })

  test("ctrl scroll clears pending operator", () => {
    const ctx = createHandler("abc")
    expect(ctx.handler.handleKey(createEvent("d").event)).toBe(true)
    expect(ctx.state.pending()).toBe("d")

    const evt = createEvent("d", { ctrl: true })
    expect(ctx.handler.handleKey(evt.event)).toBe(true)
    expect(evt.prevented()).toBe(true)
    expect(ctx.scrollCalls.at(-1)).toBe("half-down")
    expect(ctx.state.pending()).toBe("")
  })

  test("ctrl scroll not handled in insert mode", () => {
    const ctx = createHandler("abc", { mode: "insert" })
    const evt = createEvent("e", { ctrl: true })
    expect(ctx.handler.handleKey(evt.event)).toBe(false)
    expect(evt.prevented()).toBe(false)
    expect(ctx.scrollCalls.length).toBe(0)
  })

  test("ctrl scroll not handled when vim disabled", () => {
    const ctx = createHandler("abc", { enabled: false })
    const evt = createEvent("e", { ctrl: true })
    expect(ctx.handler.handleKey(evt.event)).toBe(false)
    expect(evt.prevented()).toBe(false)
    expect(ctx.scrollCalls.length).toBe(0)
  })

  test("g and G jump to top or bottom", () => {
    const ctx = createHandler("abc")

    const g = createEvent("g")
    expect(ctx.handler.handleKey(g.event)).toBe(true)
    expect(g.prevented()).toBe(true)
    expect(ctx.jumpCalls.length).toBe(0)
    expect(ctx.state.pending()).toBe("g")

    const g2 = createEvent("g")
    expect(ctx.handler.handleKey(g2.event)).toBe(true)
    expect(g2.prevented()).toBe(true)
    expect(ctx.jumpCalls.at(-1)).toBe("top")
    expect(ctx.state.pending()).toBe("")

    const G = createEvent("G")
    expect(ctx.handler.handleKey(G.event)).toBe(true)
    expect(G.prevented()).toBe(true)
    expect(ctx.jumpCalls.at(-1)).toBe("bottom")
  })

  test("gj and gk move by display line and clear pending", () => {
    const text = "abc\ndef\nghi"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 1, 1)

    expect(ctx.handler.handleKey(createEvent("g").event)).toBe(true)
    expect(ctx.state.pending()).toBe("g")

    const j = createEvent("j")
    expect(ctx.handler.handleKey(j.event)).toBe(true)
    expect(j.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.jumpCalls.length).toBe(0)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 1))

    expect(ctx.handler.handleKey(createEvent("g").event)).toBe(true)
    const k = createEvent("k")
    expect(ctx.handler.handleKey(k.event)).toBe(true)
    expect(k.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.jumpCalls.length).toBe(0)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 1))
  })

  test("gj in visual mode extends the selection", () => {
    const text = "abc\ndef"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.state.mode()).toBe("visual")
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 1))
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({
      start: 1,
      end: rowColToOffset(text, 1, 1) + 1,
    })
  })

  test("g with arrow keys moves by display line", () => {
    const text = "abc\ndef"
    const ctx = createHandler(text)

    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("down").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 0))

    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("up").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 0, 0))
  })

  test("counted gj repeats the display motion", () => {
    const text = "a\nb\nc\nd"
    const ctx = createHandler(text)

    ctx.handler.handleKey(createEvent("3").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 3, 0))
    expect(ctx.state.count()).toBe("")
  })

  test("g0, g^, and g$ move within the current display line", () => {
    const text = "  abc def ghi"
    const ctx = createHandler(text)
    const width = 6
    ;(ctx.textarea as any).editorView.getVisualCursor = () => ({
      visualRow: Math.floor(ctx.textarea.cursorOffset / width),
      visualCol: ctx.textarea.cursorOffset % width,
      logicalRow: 0,
      logicalCol: ctx.textarea.cursorOffset,
      offset: ctx.textarea.cursorOffset,
    })
    ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
      ctx.textarea.cursorOffset = offset
    }

    ctx.textarea.cursorOffset = 8
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("0").event)
    expect(ctx.textarea.cursorOffset).toBe(6)

    ctx.textarea.cursorOffset = 6
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("^").event)
    expect(ctx.textarea.cursorOffset).toBe(6)

    ctx.textarea.cursorOffset = 8
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.cursorOffset).toBe(11)
    expect(ctx.state.pending()).toBe("")
  })

  test("g^ falls back to the display-line start when the display line is blank", () => {
    const text = "      abc"
    const ctx = createHandler(text)
    const width = 6
    ;(ctx.textarea as any).editorView.getVisualCursor = () => ({
      visualRow: Math.floor(ctx.textarea.cursorOffset / width),
      visualCol: ctx.textarea.cursorOffset % width,
      logicalRow: 0,
      logicalCol: ctx.textarea.cursorOffset,
      offset: ctx.textarea.cursorOffset,
    })
    ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
      ctx.textarea.cursorOffset = offset
    }

    ctx.textarea.cursorOffset = 3
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("^").event)

    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("g^ and g$ handle shifted base-key events", () => {
    const text = "  abc def ghi"
    const ctx = createHandler(text)
    const width = 6
    ;(ctx.textarea as any).editorView.getVisualCursor = () => ({
      visualRow: Math.floor(ctx.textarea.cursorOffset / width),
      visualCol: ctx.textarea.cursorOffset % width,
      logicalRow: 0,
      logicalCol: ctx.textarea.cursorOffset,
      offset: ctx.textarea.cursorOffset,
    })
    ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
      ctx.textarea.cursorOffset = offset
    }

    ctx.textarea.cursorOffset = 1
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("6", { shift: true }).event)
    expect(ctx.textarea.cursorOffset).toBe(2)

    ctx.textarea.cursorOffset = 8
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("4", { shift: true }).event)
    expect(ctx.textarea.cursorOffset).toBe(11)
  })

  test("counted g$ moves to the end of a later display line", () => {
    const text = "aaa\nbbb\nccc"
    const ctx = createHandler(text)

    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("$").event)

    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 2))
    expect(ctx.state.count()).toBe("")
  })

  test("g$ in visual mode extends the selection", () => {
    const text = "abc def ghi"
    const ctx = createHandler(text)
    const width = 6
    ;(ctx.textarea as any).editorView.getVisualCursor = () => ({
      visualRow: Math.floor(ctx.textarea.cursorOffset / width),
      visualCol: ctx.textarea.cursorOffset % width,
      logicalRow: 0,
      logicalCol: ctx.textarea.cursorOffset,
      offset: ctx.textarea.cursorOffset,
    })
    ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
      ctx.textarea.cursorOffset = offset
    }
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("$").event)

    expect(ctx.state.mode()).toBe("visual")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 1, end: 6 })
  })

  test("dg$ deletes through display-line end charwise", () => {
    const text = "abcdefghi"
    const ctx = createHandler(text)
    const width = 3
    ;(ctx.textarea as any).editorView.getVisualCursor = () => ({
      visualRow: Math.floor(ctx.textarea.cursorOffset / width),
      visualCol: ctx.textarea.cursorOffset % width,
      logicalRow: 0,
      logicalCol: ctx.textarea.cursorOffset,
      offset: ctx.textarea.cursorOffset,
    })
    ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
      ctx.textarea.cursorOffset = offset
    }
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("$").event)

    expect(ctx.textarea.plainText).toBe("adefghi")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "bc", linewise: false })
  })

  test("horizontal display-line $ operators include current char at display-line end", () => {
    const setup = () => {
      const ctx = createHandler("abc\ndef")
      const width = 3
      ;(ctx.textarea as any).editorView.getVisualCursor = () => ({
        visualRow: Math.floor(ctx.textarea.cursorOffset / width),
        visualCol: ctx.textarea.cursorOffset % width,
        logicalRow: 0,
        logicalCol: ctx.textarea.cursorOffset,
        offset: ctx.textarea.cursorOffset,
      })
      ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
        ctx.textarea.cursorOffset = offset
      }
      ctx.textarea.cursorOffset = 2
      return ctx
    }

    const deleted = setup()
    deleted.handler.handleKey(createEvent("d").event)
    deleted.handler.handleKey(createEvent("g").event)
    deleted.handler.handleKey(createEvent("$").event)
    expect(deleted.textarea.plainText).toBe("ab\ndef")
    expect(deleted.state.register()).toEqual({ text: "c", linewise: false })

    const yanked = setup()
    yanked.handler.handleKey(createEvent("y").event)
    yanked.handler.handleKey(createEvent("g").event)
    yanked.handler.handleKey(createEvent("$").event)
    expect(yanked.textarea.plainText).toBe("abc\ndef")
    expect(yanked.textarea.cursorOffset).toBe(2)
    expect(yanked.state.register()).toEqual({ text: "c", linewise: false })

    const changed = setup()
    changed.handler.handleKey(createEvent("c").event)
    changed.handler.handleKey(createEvent("g").event)
    changed.handler.handleKey(createEvent("$").event)
    expect(changed.textarea.plainText).toBe("ab\ndef")
    expect(changed.textarea.cursorOffset).toBe(2)
    expect(changed.state.mode()).toBe("insert")
    expect(changed.state.register()).toEqual({ text: "c", linewise: false })
  })

  test("dg$ on an empty display line is a no-op", () => {
    const ctx = createHandler("abc\n\ndef")
    ;(ctx.textarea as any).editorView.getVisualCursor = () => ({
      visualRow: ctx.textarea.cursorOffset,
      visualCol: 0,
      logicalRow: 0,
      logicalCol: ctx.textarea.cursorOffset,
      offset: ctx.textarea.cursorOffset,
    })
    ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
      ctx.textarea.cursorOffset = offset
    }
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("$").event)

    expect(ctx.textarea.plainText).toBe("abc\n\ndef")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toBeNull()
  })

  test("dg0 deletes backward to display-line start charwise", () => {
    const text = "abcdefghi"
    const ctx = createHandler(text)
    const width = 3
    ;(ctx.textarea as any).editorView.getVisualCursor = () => ({
      visualRow: Math.floor(ctx.textarea.cursorOffset / width),
      visualCol: ctx.textarea.cursorOffset % width,
      logicalRow: 0,
      logicalCol: ctx.textarea.cursorOffset,
      offset: ctx.textarea.cursorOffset,
    })
    ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
      ctx.textarea.cursorOffset = offset
    }
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("0").event)

    expect(ctx.textarea.plainText).toBe("abcefghi")
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "d", linewise: false })
  })

  test("yg0 yanks backward to display-line start charwise", () => {
    const text = "abcdefghi"
    const ctx = createHandler(text)
    const width = 3
    ;(ctx.textarea as any).editorView.getVisualCursor = () => ({
      visualRow: Math.floor(ctx.textarea.cursorOffset / width),
      visualCol: ctx.textarea.cursorOffset % width,
      logicalRow: 0,
      logicalCol: ctx.textarea.cursorOffset,
      offset: ctx.textarea.cursorOffset,
    })
    ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
      ctx.textarea.cursorOffset = offset
    }
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("0").event)

    expect(ctx.textarea.plainText).toBe(text)
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "de", linewise: false })
  })

  test("cg^ changes backward to display-line first nonblank charwise", () => {
    const text = "abc  def"
    const ctx = createHandler(text)
    const width = 5
    ;(ctx.textarea as any).editorView.getVisualCursor = () => ({
      visualRow: Math.floor(ctx.textarea.cursorOffset / width),
      visualCol: ctx.textarea.cursorOffset % width,
      logicalRow: 0,
      logicalCol: ctx.textarea.cursorOffset,
      offset: ctx.textarea.cursorOffset,
    })
    ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
      ctx.textarea.cursorOffset = offset
    }
    ctx.textarea.cursorOffset = 7

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("^").event)

    expect(ctx.textarea.plainText).toBe("abc  f")
    expect(ctx.textarea.cursorOffset).toBe(5)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toEqual({ text: "de", linewise: false })
  })

  test("horizontal display-line operators support counts", () => {
    const first = createHandler("aaa\nbbb\nccc")
    first.handler.handleKey(createEvent("2").event)
    first.handler.handleKey(createEvent("d").event)
    first.handler.handleKey(createEvent("g").event)
    first.handler.handleKey(createEvent("$").event)

    expect(first.textarea.plainText).toBe("\nccc")
    expect(first.state.register()).toEqual({ text: "aaa\nbbb", linewise: false })

    const second = createHandler("aaa\nbbb\nccc")
    second.handler.handleKey(createEvent("d").event)
    second.handler.handleKey(createEvent("2").event)
    second.handler.handleKey(createEvent("g").event)
    second.handler.handleKey(createEvent("$").event)

    expect(second.textarea.plainText).toBe("\nccc")
    expect(second.state.register()).toEqual({ text: "aaa\nbbb", linewise: false })
  })

  test("repeated gj preserves desired visual column across short lines", () => {
    const text = "abcd\ne\nijkl"
    const ctx = createHandler(text)
    const lineEnd = (offset: number) => {
      const end = text.indexOf("\n", offset)
      return end === -1 ? text.length : end
    }
    const nextLineStart = (offset: number) => {
      const end = lineEnd(offset)
      return end >= text.length ? undefined : end + 1
    }
    ;(ctx.textarea as any).editorView.getVisualCursor = () => {
      const { row, col } = offsetToRowCol(text, ctx.textarea.cursorOffset)
      return { visualRow: row, visualCol: col, logicalRow: row, logicalCol: col, offset: ctx.textarea.cursorOffset }
    }
    ;(ctx.textarea as any).editorView.setCursorByOffset = (offset: number) => {
      ctx.textarea.cursorOffset = offset
    }
    ;(ctx.textarea as any).editorView.moveDownVisual = () => {
      const col = (ctx.textarea as any).editorView.getVisualCursor().visualCol
      const start = nextLineStart(ctx.textarea.cursorOffset)
      if (start === undefined) return
      ctx.textarea.cursorOffset = Math.min(start + col, lineEnd(start))
    }

    ctx.textarea.cursorOffset = rowColToOffset(text, 0, 3)

    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 0))

    ctx.handler.handleKey(createEvent("g").event)
    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 3))
  })

  test("gJ is not treated as display motion", () => {
    const ctx = createHandler("ab\ncd")

    ctx.handler.handleKey(createEvent("g").event)
    const J = createEvent("J", { shift: true })
    ctx.handler.handleKey(J.event)

    expect(ctx.state.pending()).toBe("")
    expect(ctx.textarea.plainText).toBe("ab cd")
  })

  test("H, M, L jump to high, middle, and low", () => {
    const ctx = createHandler("abc")

    ctx.handler.handleKey(createEvent("H").event)
    ctx.handler.handleKey(createEvent("M").event)
    ctx.handler.handleKey(createEvent("L").event)

    expect(ctx.jumpCalls).toEqual(["high", "middle", "low"])
  })

  test("pending g cancels on other keys", () => {
    const ctx = createHandler("abc")
    expect(ctx.handler.handleKey(createEvent("g").event)).toBe(true)
    expect(ctx.state.pending()).toBe("g")
    expect(ctx.state.pendingDisplay()).toBe("g")

    const w = createEvent("w")
    expect(ctx.handler.handleKey(w.event)).toBe(true)
    expect(w.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")
  })

  test("pending transition d to g", () => {
    const ctx = createHandler("abc")
    expect(ctx.handler.handleKey(createEvent("d").event)).toBe(true)
    expect(ctx.state.pending()).toBe("d")
    expect(ctx.state.pendingDisplay()).toBe("d")

    const g = createEvent("g")
    expect(ctx.handler.handleKey(g.event)).toBe(true)
    expect(g.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("g")
    expect(ctx.state.pendingDisplay()).toBe("dg")

    const g2 = createEvent("g")
    expect(ctx.handler.handleKey(g2.event)).toBe(true)
    expect(g2.prevented()).toBe(true)
    expect(ctx.jumpCalls.at(-1)).toBe("top")
    expect(ctx.scrollCalls.length).toBe(0)
    expect(ctx.state.pending()).toBe("")
  })

  test("pending command display tracks counts and operators", () => {
    const beforeOperator = createHandler("abc")
    beforeOperator.handler.handleKey(createEvent("2").event)
    beforeOperator.handler.handleKey(createEvent("d").event)
    expect(beforeOperator.state.pending()).toBe("d")
    expect(beforeOperator.state.pendingDisplay()).toBe("2d")

    const afterOperator = createHandler("abc")
    afterOperator.handler.handleKey(createEvent("d").event)
    afterOperator.handler.handleKey(createEvent("2").event)
    expect(afterOperator.state.pending()).toBe("d")
    expect(afterOperator.state.pendingDisplay()).toBe("d2")

    afterOperator.handler.handleKey(createEvent("g").event)
    expect(afterOperator.state.pending()).toBe("g")
    expect(afterOperator.state.pendingDisplay()).toBe("d2g")

    const beforeOperatorDisplayLine = createHandler("abc")
    beforeOperatorDisplayLine.handler.handleKey(createEvent("2").event)
    beforeOperatorDisplayLine.handler.handleKey(createEvent("d").event)
    beforeOperatorDisplayLine.handler.handleKey(createEvent("g").event)
    expect(beforeOperatorDisplayLine.state.pending()).toBe("g")
    expect(beforeOperatorDisplayLine.state.pendingDisplay()).toBe("2dg")

    const motion = createHandler("abc")
    motion.handler.handleKey(createEvent("2").event)
    motion.handler.handleKey(createEvent("g").event)
    expect(motion.state.pending()).toBe("g")
    expect(motion.state.pendingDisplay()).toBe("2g")

    const countedFind = createHandler("abc")
    countedFind.handler.handleKey(createEvent("2").event)
    countedFind.handler.handleKey(createEvent("f").event)
    expect(countedFind.state.pending()).toBe("f")
    expect(countedFind.state.pendingDisplay()).toBe("2f")

    const find = createHandler("abc")
    find.handler.handleKey(createEvent("d").event)
    find.handler.handleKey(createEvent("2").event)
    find.handler.handleKey(createEvent("f").event)
    expect(find.state.pending()).toBe("f")
    expect(find.state.pendingDisplay()).toBe("d2f")

    const countedOperatorFind = createHandler("abc")
    countedOperatorFind.handler.handleKey(createEvent("2").event)
    countedOperatorFind.handler.handleKey(createEvent("d").event)
    countedOperatorFind.handler.handleKey(createEvent("f").event)
    expect(countedOperatorFind.state.pending()).toBe("f")
    expect(countedOperatorFind.state.pendingDisplay()).toBe("2df")

    const textObject = createHandler("abc")
    textObject.handler.handleKey(createEvent("c").event)
    textObject.handler.handleKey(createEvent("i").event)
    expect(textObject.state.pending()).toBe("c")
    expect(textObject.state.pendingDisplay()).toBe("ci")
  })

  test("pending command display respects operator count cap", () => {
    const ctx = createHandler("abc")
    ctx.handler.handleKey(createEvent("d").event)
    for (const key of ["1", "2", "3", "4", "5"]) ctx.handler.handleKey(createEvent(key).event)

    expect(ctx.state.count()).toBe("1234")
    expect(ctx.state.pending()).toBe("d")
    expect(ctx.state.pendingDisplay()).toBe("d1234")
  })

  test("pending d then G clears and jumps", () => {
    const ctx = createHandler("abc")
    expect(ctx.handler.handleKey(createEvent("d").event)).toBe(true)
    expect(ctx.state.pending()).toBe("d")

    const G = createEvent("G")
    expect(ctx.handler.handleKey(G.event)).toBe(true)
    expect(G.prevented()).toBe(true)
    expect(ctx.jumpCalls.at(-1)).toBe("bottom")
    expect(ctx.state.pending()).toBe("")
  })

  test("g not handled in insert mode", () => {
    const ctx = createHandler("abc", { mode: "insert" })
    const g = createEvent("g")
    expect(ctx.handler.handleKey(g.event)).toBe(false)
    expect(g.prevented()).toBe(false)
    expect(ctx.jumpCalls.length).toBe(0)
  })

  test("g not handled when vim disabled", () => {
    const ctx = createHandler("abc", { enabled: false })
    const g = createEvent("g")
    expect(ctx.handler.handleKey(g.event)).toBe(false)
    expect(g.prevented()).toBe(false)
    expect(ctx.jumpCalls.length).toBe(0)
  })

  test("repeated ctrl scroll keeps pending clear", () => {
    const ctx = createHandler("abc")
    expect(ctx.handler.handleKey(createEvent("d").event)).toBe(true)
    expect(ctx.state.pending()).toBe("d")

    const first = createEvent("d", { ctrl: true })
    expect(ctx.handler.handleKey(first.event)).toBe(true)
    expect(first.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")

    const second = createEvent("d", { ctrl: true })
    expect(ctx.handler.handleKey(second.event)).toBe(true)
    expect(second.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")

    expect(ctx.scrollCalls).toEqual(["half-down", "half-down"])
  })

  test("repeated G does not create pending", () => {
    const ctx = createHandler("abc")

    const first = createEvent("G")
    expect(ctx.handler.handleKey(first.event)).toBe(true)
    expect(first.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")

    const second = createEvent("G")
    expect(ctx.handler.handleKey(second.event)).toBe(true)
    expect(second.prevented()).toBe(true)
    expect(ctx.state.pending()).toBe("")

    expect(ctx.jumpCalls).toEqual(["bottom", "bottom"])
  })

  test("v enters visual mode and sets selection", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 2

    const v = createEvent("v")
    expect(ctx.handler.handleKey(v.event)).toBe(true)
    expect(v.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("visual")
    expect(ctx.state.anchor()).toBe(2)
  })

  test("v then motion extends selection", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    expect(ctx.state.mode()).toBe("visual")

    ctx.handler.handleKey(createEvent("l").event)
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 0, end: 2 })

    ctx.handler.handleKey(createEvent("l").event)
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 0, end: 3 })
  })

  test("v then w extends selection by word", () => {
    const ctx = createHandler("hello world test")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.textarea.cursorOffset).toBe(6)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 0, end: 7 })
  })

  test("visual character motions support counts", () => {
    const text = "one\ntwo\nthree\nfour"
    const ctx = createHandler(text)

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 0))
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({
      start: 0,
      end: rowColToOffset(text, 2, 0) + 1,
    })
  })

  test("visual line motions support counts", () => {
    const text = "one\ntwo\nthree\nfour"
    const ctx = createHandler(text)

    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("2").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 0))
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 0, end: 14 })
  })

  test("visual j preserves desired column across short lines", () => {
    const text = "abcdef\nx\nabcdef"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 0, 5)

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 0))

    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 5))
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({
      start: rowColToOffset(text, 0, 5),
      end: rowColToOffset(text, 2, 5) + 1,
    })
  })

  test("visual arrow down preserves desired column across short lines", () => {
    const text = "abcdef\nx\nabcdef"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 0, 5)

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("down").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 0))

    ctx.handler.handleKey(createEvent("down").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 5))
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({
      start: rowColToOffset(text, 0, 5),
      end: rowColToOffset(text, 2, 5) + 1,
    })

    ctx.handler.handleKey(createEvent("up").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 1, 0))

    ctx.handler.handleKey(createEvent("up").event)
    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 0, 5))
  })

  test("entering visual mode preserves desired column", () => {
    const text = "abcdef\nx\nabcdef"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 0, 5)

    ctx.handler.handleKey(createEvent("j").event)
    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 5))
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({
      start: rowColToOffset(text, 1, 0),
      end: rowColToOffset(text, 2, 5) + 1,
    })
  })

  test("entering visual-line mode preserves desired column", () => {
    const text = "abcdef\nx\nabcdef"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 0, 5)

    ctx.handler.handleKey(createEvent("j").event)
    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 5))
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({
      start: rowColToOffset(text, 1, 0),
      end: text.length,
    })
  })

  test("exiting visual mode with v preserves desired column", () => {
    const text = "abcdef\nx\nabcdef"
    const ctx = createHandler(text)
    ctx.textarea.cursorOffset = rowColToOffset(text, 0, 5)

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("j").event)
    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("j").event)

    expect(ctx.textarea.cursorOffset).toBe(rowColToOffset(text, 2, 5))
    expect(ctx.state.mode()).toBe("normal")
  })

  test("v then escape exits visual mode", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("v").event)
    expect(ctx.state.mode()).toBe("visual")

    ctx.handler.handleKey(createEvent("escape").event)
    expect(ctx.state.mode()).toBe("normal")
    expect((ctx.textarea as any).editorView.getSelection()).toBe(null)
  })

  test("i does not enter insert in visual mode", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("v").event)
    expect(ctx.state.mode()).toBe("visual")

    const i = createEvent("i")
    expect(ctx.handler.handleKey(i.event)).toBe(true)
    expect(i.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("visual")
  })

  test("v twice toggles back to normal", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("v").event)
    expect(ctx.state.mode()).toBe("visual")

    ctx.handler.handleKey(createEvent("v").event)
    expect(ctx.state.mode()).toBe("normal")
    expect((ctx.textarea as any).editorView.getSelection()).toBe(null)
  })

  test("visual d deletes selection and populates register", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)

    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.plainText).toBe(" world")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("visual d falls back to anchor when editor selection is cleared", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("v").event)
    ;(ctx.textarea as any).editorView.resetSelection()

    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.plainText).toBe("hllo")
    expect(ctx.state.register()).toEqual({ text: "e", linewise: false })
    expect(ctx.state.mode()).toBe("normal")
  })

  test("visual y yanks selection without deleting", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)

    ctx.handler.handleKey(createEvent("y").event)
    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("visual e then y yanks through end of word", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("e").event)
    ctx.handler.handleKey(createEvent("y").event)
    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("visual c deletes selection and enters insert", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)

    ctx.handler.handleKey(createEvent("c").event)
    expect(ctx.textarea.plainText).toBe(" world")
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("visual C wipes selected line and enters insert", () => {
    const ctx = createHandler("one two three")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("w").event)

    ctx.handler.handleKey(createEvent("C").event)
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "one two three", linewise: true })
  })

  test("visual C across multiple lines collapses to one empty line", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("j").event)

    ctx.handler.handleKey(createEvent("C").event)
    expect(ctx.textarea.plainText).toBe("\nthree")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo", linewise: true })
  })

  test("visual D removes selected line and exits visual", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)

    ctx.handler.handleKey(createEvent("D").event)
    expect(ctx.textarea.plainText).toBe("one\nthree")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "two", linewise: true })
  })

  test("visual D across multiple lines removes all selected lines", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("j").event)

    ctx.handler.handleKey(createEvent("D").event)
    expect(ctx.textarea.plainText).toBe("three")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "one\ntwo", linewise: true })
  })

  test("visual shift+d still triggers linewise delete", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)

    ctx.handler.handleKey(createEvent("d", { shift: true }).event)
    expect(ctx.textarea.plainText).toBe("one\nthree")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "two", linewise: true })
  })

  test("visual shift+c still triggers linewise change", () => {
    const ctx = createHandler("one two three")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("w").event)

    ctx.handler.handleKey(createEvent("c", { shift: true }).event)
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "one two three", linewise: true })
  })

  test("visual-line C wipes line content and enters insert", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("V").event)

    ctx.handler.handleKey(createEvent("C").event)
    expect(ctx.textarea.plainText).toBe("one\n\nthree")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "two", linewise: true })
  })

  test("visual-line D removes the selected line entirely", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("V").event)

    ctx.handler.handleKey(createEvent("D").event)
    expect(ctx.textarea.plainText).toBe("one\nthree")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "two", linewise: true })
  })

  test("visual D on last line removes line and trailing buffer", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)

    ctx.handler.handleKey(createEvent("D").event)
    expect(ctx.textarea.plainText).toBe("one")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "two", linewise: true })
  })

  test("visual C on last line empties content and stays on line", () => {
    const ctx = createHandler("one\ntwo")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)

    ctx.handler.handleKey(createEvent("C").event)
    expect(ctx.textarea.plainText).toBe("one\n")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.state.register()).toEqual({ text: "two", linewise: true })
  })

  test("visual x is same as d", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 0

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)

    ctx.handler.handleKey(createEvent("x").event)
    expect(ctx.textarea.plainText).toBe("lo world")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "hel", linewise: false })
  })

  test("visual p replaces selection with register", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.state.register()).toEqual({ text: "world", linewise: false })

    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)

    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("world world")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "hello", linewise: false })
  })

  test("visual-line p replaces selected lines with linewise register", () => {
    const ctx = createHandler("one\ntwo\nthree")

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("y").event)
    expect(ctx.state.register()).toEqual({ text: "one", linewise: true })

    ctx.textarea.cursorOffset = 4
    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("one\none\nthree")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "two", linewise: true })
  })

  test("visual-line p replaces the last selected line", () => {
    const ctx = createHandler("one\ntwo")

    ctx.handler.handleKey(createEvent("y").event)
    ctx.handler.handleKey(createEvent("y").event)

    ctx.textarea.cursorOffset = 4
    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("one\none")
    expect(ctx.state.register()).toEqual({ text: "two", linewise: true })
  })

  test("visual ~ toggles selected text and exits visual mode", () => {
    const ctx = createHandler("abCD ef")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("l").event)

    const tilde = createEvent("~")
    expect(ctx.handler.handleKey(tilde.event)).toBe(true)
    expect(tilde.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("aBcd ef")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.mode()).toBe("normal")
    expect((ctx.textarea as any).editorView.getSelection()).toBe(null)
  })

  test("visual r replaces selection before jump handling", () => {
    const ctx = createHandler("abcd\nefgh")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("r").event)
    ctx.handler.handleKey(createEvent("G").event)

    expect(ctx.textarea.plainText).toBe("aGGd\nefgh")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.jumpCalls).toEqual([])
    expect(ctx.state.mode()).toBe("normal")
  })

  test("visual r return inserts carriage returns without splitting lines", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("l").event)
    ctx.handler.handleKey(createEvent("r").event)
    ctx.handler.handleKey(createEvent("return").event)

    expect(ctx.textarea.plainText).toBe("a\r\rd")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("visual mode with backward motion", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("h").event)
    ctx.handler.handleKey(createEvent("h").event)
    expect(ctx.textarea.cursorOffset).toBe(3)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 3, end: 6 })
  })

  test("visual d deletes backward selection", () => {
    const ctx = createHandler("abcdef")
    ctx.textarea.cursorOffset = 4

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("h").event)
    ctx.handler.handleKey(createEvent("h").event)

    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.plainText).toBe("abf")
    expect(ctx.state.register()).toEqual({ text: "cde", linewise: false })
    expect(ctx.state.mode()).toBe("normal")
  })

  test("visual w d deletes selection through end of text", () => {
    const ctx = createHandler("hello world", { strict: true })

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("w").event)
    ctx.handler.handleKey(createEvent("d").event)

    expect(ctx.textarea.plainText).toBe("orld")
    expect(ctx.state.register()).toEqual({ text: "hello w", linewise: false })
    expect(ctx.state.mode()).toBe("normal")
  })

  test("deleteSelection uses anchor range for charwise delete", () => {
    const textarea = createTextarea("word1 word2 word3")
    textarea.cursorOffset = 10

    const reg = deleteSelection(textarea, false, 6)

    expect(textarea.plainText).toBe("word1  word3")
    expect(reg).toEqual({ text: "word2", linewise: false })
  })

  test("deleteSelection ignores stale editor selection", () => {
    const textarea = createTextarea("word1 word2 word3")
    ;(textarea as any).editorView.setSelection(0, 5)
    textarea.cursorOffset = 10

    const reg = deleteSelection(textarea, false, 6)

    expect(textarea.plainText).toBe("word1  word3")
    expect(reg).toEqual({ text: "word2", linewise: false })
  })

  test("visual mode $ selects to end of line", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 6

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.cursorOffset).toBe(10)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 6, end: 11 })
  })

  test("visual mode % extends selection through matching bracket", () => {
    const ctx = createHandler("a (b) c")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("v").event)
    ctx.handler.handleKey(createEvent("%").event)

    expect(ctx.textarea.cursorOffset).toBe(4)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 2, end: 5 })
  })

  test("V enters visual-line mode", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    const v = createEvent("V")
    expect(ctx.handler.handleKey(v.event)).toBe(true)
    expect(v.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("visual-line")
    expect(ctx.state.anchor()).toBe(5)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 4, end: 8 })
  })

  test("V selects full current line on single line", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 2

    ctx.handler.handleKey(createEvent("V").event)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 0, end: 5 })
  })

  test("V then j extends by full line", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("V").event)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 0, end: 4 })

    ctx.handler.handleKey(createEvent("j").event)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 0, end: 8 })
  })

  test("V then k extends upward by full line", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("k").event)
    expect((ctx.textarea as any).editorView.getSelection()).toEqual({ start: 0, end: 8 })
  })

  test("V then d deletes full lines with linewise register", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.plainText).toBe("one\nthree")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()?.linewise).toBe(true)
  })

  test("V then d falls back to anchor when editor selection is cleared", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("V").event)
    ;(ctx.textarea as any).editorView.resetSelection()

    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.plainText).toBe("one\nthree")
    expect(ctx.state.register()).toEqual({ text: "two\n", linewise: true })
    expect(ctx.state.mode()).toBe("normal")
  })

  test("V then y yanks full lines with linewise register", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("y").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo\nthree")
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.register()).toEqual({ text: "two\n", linewise: true })
  })

  test("V then ~ toggles selected lines and exits visual-line", () => {
    const ctx = createHandler("one\nTwo\nTHREE")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("V").event)

    const tilde = createEvent("~")
    expect(ctx.handler.handleKey(tilde.event)).toBe(true)
    expect(tilde.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("one\ntWO\nTHREE")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("normal")
    expect((ctx.textarea as any).editorView.getSelection()).toBe(null)
  })

  test("V select lines 2-4 then d places cursor at line 1 start", () => {
    const ctx = createHandler("line 1\nline 2\nline 3\nline 4")
    ctx.textarea.cursorOffset = 7

    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("j").event)
    ctx.handler.handleKey(createEvent("j").event)

    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.plainText).toBe("line 1")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("V delete middle line places cursor at next line start", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("V").event)
    ctx.handler.handleKey(createEvent("d").event)
    expect(ctx.textarea.plainText).toBe("one\nthree")
    expect(ctx.textarea.cursorOffset).toBe(4)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("V then escape exits", () => {
    const ctx = createHandler("hello")
    ctx.handler.handleKey(createEvent("V").event)
    expect(ctx.state.mode()).toBe("visual-line")

    ctx.handler.handleKey(createEvent("escape").event)
    expect(ctx.state.mode()).toBe("normal")
    expect((ctx.textarea as any).editorView.getSelection()).toBe(null)
  })

  test("V twice toggles off", () => {
    const ctx = createHandler("hello")
    ctx.handler.handleKey(createEvent("V").event)
    expect(ctx.state.mode()).toBe("visual-line")

    ctx.handler.handleKey(createEvent("V").event)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("v in visual-line switches to characterwise", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("V").event)
    expect(ctx.state.mode()).toBe("visual-line")

    ctx.handler.handleKey(createEvent("v").event)
    expect(ctx.state.mode()).toBe("visual")
    expect(ctx.state.anchor()).toBe(5)
  })

  test("V in characterwise visual switches to visual-line", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("v").event)
    expect(ctx.state.mode()).toBe("visual")

    ctx.handler.handleKey(createEvent("V").event)
    expect(ctx.state.mode()).toBe("visual-line")
    expect(ctx.state.anchor()).toBe(5)
  })
})

// vim parity fixtures for `{` and `}` operators. Each row is a behavior
// observed from nvim (--clean, nofixendofline). Fixtures drive the same
// handler path as normal operator-pending input.
//
// (row, col) are 1-indexed vim coordinates. buf is the buffer after the op.
// reg is the expected register content, with linewise flag.
type ParaFixture = {
  text: string
  row: number
  col: number
  op: "d" | "c" | "y"
  motion: "}" | "{"
  buf: string
  reg: { text: string; linewise: boolean }
}

function rowColToOffsetPara(text: string, row: number, col: number) {
  const lines = text.split("\n")
  let offset = 0
  for (let i = 0; i < row - 1; i++) offset += lines[i]!.length + 1
  return offset + (col - 1)
}

function runFixture(f: ParaFixture) {
  const ctx = createHandler(f.text)
  ctx.textarea.cursorOffset = rowColToOffsetPara(f.text, f.row, f.col)
  ctx.handler.handleKey(createEvent(f.op).event)
  ctx.handler.handleKey(createEvent(f.motion).event)
  expect(ctx.textarea.plainText).toBe(f.buf)
  expect(ctx.state.register()).toEqual(f.reg)
}

describe("vim escape sequence", () => {
  test("jk exits insert mode and removes the typed j", () => {
    const ctx = createHandler("hello", { mode: "insert", vimEscapeSequence: "jk" })
    ctx.textarea.cursorOffset = 3

    expect(ctx.handler.handleKey(createEvent("j").event)).toBe(false)
    ctx.textarea.insertText("j")
    expect(ctx.state.mode()).toBe("insert")

    const k = createEvent("k")
    expect(ctx.handler.handleKey(k.event)).toBe(true)
    expect(k.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.textarea.plainText).toBe("hello")
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("jx stays in insert mode and keeps both chars", () => {
    const ctx = createHandler("hello", { mode: "insert", vimEscapeSequence: "jk" })
    ctx.textarea.cursorOffset = 3

    expect(ctx.handler.handleKey(createEvent("j").event)).toBe(false)
    ctx.textarea.insertText("j")
    expect(ctx.state.mode()).toBe("insert")

    expect(ctx.handler.handleKey(createEvent("x").event)).toBe(false)
    ctx.textarea.insertText("x")
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("heljxlo")
  })

  test("j followed by timeout stays as normal input", async () => {
    const ctx = createHandler("hello", { mode: "insert", vimEscapeSequence: "jk" })
    ctx.textarea.cursorOffset = 3

    expect(ctx.handler.handleKey(createEvent("j").event)).toBe(false)
    ctx.textarea.insertText("j")
    expect(ctx.state.mode()).toBe("insert")

    await new Promise((resolve) => setTimeout(resolve, 350))

    const k = createEvent("k")
    expect(ctx.handler.handleKey(k.event)).toBe(false)
    ctx.textarea.insertText("k")
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("heljklo")
  })

  test("j then ctrl+k does not complete the sequence", () => {
    const ctx = createHandler("hello", { mode: "insert", vimEscapeSequence: "jk" })
    ctx.textarea.cursorOffset = 3

    expect(ctx.handler.handleKey(createEvent("j").event)).toBe(false)
    ctx.textarea.insertText("j")
    expect(ctx.state.mode()).toBe("insert")

    const ctrlK = createEvent("k", { ctrl: true })
    expect(ctx.handler.handleKey(ctrlK.event)).toBe(false)
    expect(ctrlK.prevented()).toBe(false)
    expect(ctx.state.mode()).toBe("insert")
    expect(ctx.textarea.plainText).toBe("heljlo")
  })

  test("escape takes priority over pending escape sequence", () => {
    const ctx = createHandler("hello", { mode: "insert", vimEscapeSequence: "jk" })
    ctx.textarea.cursorOffset = 3

    expect(ctx.handler.handleKey(createEvent("j").event)).toBe(false)
    ctx.textarea.insertText("j")
    expect(ctx.state.mode()).toBe("insert")

    const esc = createEvent("escape")
    expect(ctx.handler.handleKey(esc.event)).toBe(true)
    expect(esc.prevented()).toBe(true)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.textarea.plainText).toBe("heljlo")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })
})

describe("vim paragraph operator parity", () => {
  test("d} col 0 multi-line no trailing \\n: linewise", () => {
    runFixture({
      text: "one\ntwo",
      row: 1,
      col: 1,
      op: "d",
      motion: "}",
      buf: "",
      reg: { text: "one\ntwo\n", linewise: true },
    })
  })

  test("d} col 0 multi-line trailing \\n: linewise consumes trailing \\n", () => {
    runFixture({
      text: "one\ntwo\n",
      row: 1,
      col: 1,
      op: "d",
      motion: "}",
      buf: "",
      reg: { text: "one\ntwo\n", linewise: true },
    })
  })

  test("y} col 0 multi-line trailing \\n: char-wise (not linewise)", () => {
    runFixture({
      text: "one\ntwo\n",
      row: 1,
      col: 1,
      op: "y",
      motion: "}",
      buf: "one\ntwo\n",
      reg: { text: "one\ntwo", linewise: false },
    })
  })

  test("c} col 0 multi-line trailing \\n: char-wise", () => {
    runFixture({
      text: "one\ntwo\n",
      row: 1,
      col: 1,
      op: "c",
      motion: "}",
      buf: "\n",
      reg: { text: "one\ntwo", linewise: false },
    })
  })

  test("d} col 0 single line trailing \\n: char-wise (no multi-line promotion)", () => {
    runFixture({
      text: "abc\n",
      row: 1,
      col: 1,
      op: "d",
      motion: "}",
      buf: "\n",
      reg: { text: "abc", linewise: false },
    })
  })

  test("d} col > 0: char-wise with exclusive-to-inclusive (end-of-prev-line)", () => {
    runFixture({
      text: "one\n\nb",
      row: 1,
      col: 2,
      op: "d",
      motion: "}",
      buf: "o\n\nb",
      reg: { text: "ne", linewise: false },
    })
  })

  test("d} col 0 blank target: linewise through blank's \\n", () => {
    runFixture({
      text: "one\ntwo\n\nthree",
      row: 1,
      col: 1,
      op: "d",
      motion: "}",
      buf: "\nthree",
      reg: { text: "one\ntwo\n", linewise: true },
    })
  })

  test("y} col 0 blank target: linewise", () => {
    runFixture({
      text: "one\ntwo\n\nthree",
      row: 1,
      col: 1,
      op: "y",
      motion: "}",
      buf: "one\ntwo\n\nthree",
      reg: { text: "one\ntwo\n", linewise: true },
    })
  })

  test("c} col 0 blank target: linewise strips trailing \\n", () => {
    runFixture({
      text: "one\ntwo\n\nthree",
      row: 1,
      col: 1,
      op: "c",
      motion: "}",
      buf: "\n\nthree",
      reg: { text: "one\ntwo\n", linewise: true },
    })
  })

  test("d} cursor on blank, target blank: linewise delete of content paragraph", () => {
    runFixture({
      text: "a\n\n\nb\n\nc",
      row: 2,
      col: 1,
      op: "d",
      motion: "}",
      buf: "a\n\nc",
      reg: { text: "\n\nb\n", linewise: true },
    })
  })

  test("c} cursor on blank, target blank: linewise strip trailing \\n", () => {
    runFixture({
      text: "a\n\n\nb\n\nc",
      row: 2,
      col: 1,
      op: "c",
      motion: "}",
      buf: "a\n\n\nc",
      reg: { text: "\n\nb\n", linewise: true },
    })
  })

  test("d} cursor on blank, target EOF no trailing \\n: extends start backward", () => {
    runFixture({
      text: "one\n\ntwo",
      row: 2,
      col: 1,
      op: "d",
      motion: "}",
      buf: "one",
      reg: { text: "\ntwo\n", linewise: true },
    })
  })

  test("y} cursor on blank, target EOF: char-wise", () => {
    runFixture({
      text: "one\n\ntwo",
      row: 2,
      col: 1,
      op: "y",
      motion: "}",
      buf: "one\n\ntwo",
      reg: { text: "\ntwo", linewise: false },
    })
  })

  test("d} cursor on blank, target EOF trailing \\n: no backward extension", () => {
    runFixture({
      text: "one\n\ntwo\n",
      row: 2,
      col: 1,
      op: "d",
      motion: "}",
      buf: "one\n",
      reg: { text: "\ntwo\n", linewise: true },
    })
  })

  test("d} on last char EOF no trailing \\n: char-wise single char", () => {
    runFixture({
      text: "abc",
      row: 1,
      col: 3,
      op: "d",
      motion: "}",
      buf: "ab",
      reg: { text: "c", linewise: false },
    })
  })

  test("d} on single-char buffer: deletes everything", () => {
    runFixture({
      text: "a",
      row: 1,
      col: 1,
      op: "d",
      motion: "}",
      buf: "",
      reg: { text: "a", linewise: false },
    })
  })

  test("d} content col 0, blank line 2 target: linewise delete of single line", () => {
    runFixture({
      text: "one\n\n",
      row: 1,
      col: 1,
      op: "d",
      motion: "}",
      buf: "\n",
      reg: { text: "one\n", linewise: true },
    })
  })

  test("y} from blank with only blanks ahead: linewise single step", () => {
    runFixture({
      text: "a\n\n\n",
      row: 2,
      col: 1,
      op: "y",
      motion: "}",
      buf: "a\n\n\n",
      reg: { text: "\n", linewise: true },
    })
  })

  // c} on blank-only buffer with adjacent blank target produces an empty
  // linewise span, so Vim no-ops the operator (no edit, no insert mode).
  test("c} blank-only buffer: no-op, mode unchanged, register unchanged", () => {
    const ctx = createHandler("\n\n")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("}").event)
    expect(ctx.textarea.plainText).toBe("\n\n")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("normal")
    expect(ctx.state.pending()).toBe("")
    expect(ctx.state.register()).toBeNull()
  })

  test("d{ col 0, target 0: linewise", () => {
    runFixture({
      text: "one\ntwo",
      row: 2,
      col: 1,
      op: "d",
      motion: "{",
      buf: "two",
      reg: { text: "one\n", linewise: true },
    })
  })

  test("y{ col 0, target 0: linewise", () => {
    runFixture({
      text: "one\ntwo",
      row: 2,
      col: 1,
      op: "y",
      motion: "{",
      buf: "one\ntwo",
      reg: { text: "one\n", linewise: true },
    })
  })

  test("c{ col 0, target 0: linewise strips trailing \\n", () => {
    runFixture({
      text: "one\ntwo",
      row: 2,
      col: 1,
      op: "c",
      motion: "{",
      buf: "\ntwo",
      reg: { text: "one\n", linewise: true },
    })
  })

  test("d{ col > 0: char-wise", () => {
    runFixture({
      text: "one\ntwo\n\nthree",
      row: 4,
      col: 2,
      op: "d",
      motion: "{",
      buf: "one\ntwo\nhree",
      reg: { text: "\nt", linewise: false },
    })
  })

  test("d{ cursor on blank, target 0: linewise", () => {
    runFixture({
      text: "one\n\ntwo",
      row: 2,
      col: 1,
      op: "d",
      motion: "{",
      buf: "\ntwo",
      reg: { text: "one\n", linewise: true },
    })
  })

  test("c{ cursor on blank, target 0: linewise strips \\n", () => {
    runFixture({
      text: "one\n\ntwo",
      row: 2,
      col: 1,
      op: "c",
      motion: "{",
      buf: "\n\ntwo",
      reg: { text: "one\n", linewise: true },
    })
  })

  test("d{ content col 0 between paragraphs: deletes blank separator", () => {
    runFixture({
      text: "one\n\ntwo",
      row: 3,
      col: 1,
      op: "d",
      motion: "{",
      buf: "one\ntwo",
      reg: { text: "\n", linewise: true },
    })
  })

  test("d{ cursor at start of buffer: no-op, register unchanged", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 0
    ctx.handler.handleKey(createEvent("d").event)
    ctx.handler.handleKey(createEvent("{").event)
    expect(ctx.textarea.plainText).toBe("abc")
    expect(ctx.state.register()).toBeNull()
  })

  test("d{ crosses multiple paragraphs from col 0: linewise delete to blank", () => {
    runFixture({
      text: "one\ntwo\n\nthree",
      row: 3,
      col: 1,
      op: "d",
      motion: "{",
      buf: "\nthree",
      reg: { text: "one\ntwo\n", linewise: true },
    })
  })

  test("d{ col > 0 crossing paragraphs: char-wise to prev blank \\n", () => {
    runFixture({
      text: "one\ntwo\n\nthree\nfour",
      row: 5,
      col: 4,
      op: "d",
      motion: "{",
      buf: "one\ntwo\nr",
      reg: { text: "\nthree\nfou", linewise: false },
    })
  })
})

describe("vim dot repeat", () => {
  type RepeatFilePart = {
    type: "file"
    filename: string
    source: { type: "file"; path: string; text: { start: number; end: number; value: string } }
  }

  const repeatFilePartDataEqual = (before: unknown, after: unknown) => {
    const normalize = (value: unknown) =>
      Array.isArray(value)
        ? (value as RepeatFilePart[]).map((part) => ({
            ...part,
            source: {
              ...part.source,
              text: {
                ...part.source.text,
                start: 0,
                end: 0,
              },
            },
          }))
        : value
    return Bun.deepEquals(normalize(before), normalize(after))
  }

  function press(ctx: ReturnType<typeof createHandler>, name: string, options?: Parameters<typeof createEvent>[1]) {
    return ctx.handler.handleKey(createEvent(name, options).event)
  }

  test("dot repeats x", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    press(ctx, "x")
    expect(ctx.textarea.plainText).toBe("acd")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("ad")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("dot repeats dd", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 0

    press(ctx, "d")
    press(ctx, "d")
    expect(ctx.textarea.plainText).toBe("two\nthree")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("three")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("dot repeats counted dd", () => {
    const ctx = createHandler("one\ntwo\nthree\nfour\nfive\nsix")

    press(ctx, "3")
    press(ctx, "d")
    press(ctx, "d")
    expect(ctx.textarea.plainText).toBe("four\nfive\nsix")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("dot repeats d% from the current cursor", () => {
    const ctx = createHandler("(a) (b)")

    press(ctx, "d")
    press(ctx, "%")
    expect(ctx.textarea.plainText).toBe(" (b)")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("dot repeats dgj from the current cursor", () => {
    const ctx = createHandler("aa\nbb\ncc\ndd")

    press(ctx, "d")
    press(ctx, "g")
    press(ctx, "j")
    expect(ctx.textarea.plainText).toBe("bb\ncc\ndd")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("cc\ndd")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("dot repeats cgj inserted text from the current cursor", () => {
    const ctx = createHandler("aa\nbb\ncc")

    press(ctx, "c")
    press(ctx, "g")
    press(ctx, "j")
    ctx.textarea.insertText("X")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("X\nbb\ncc")

    ctx.textarea.cursorOffset = 2
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("X\nX\ncc")
    expect(ctx.textarea.cursorOffset).toBe(2)
  })

  test("dot repeat of c% no-ops when the repeated motion fails", () => {
    const ctx = createHandler("(a) z")

    press(ctx, "c")
    press(ctx, "%")
    ctx.textarea.insertText("X")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("X z")

    press(ctx, "w")
    expect(ctx.textarea.cursorOffset).toBe(2)
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("X z")
    expect(ctx.textarea.cursorOffset).toBe(2)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("dot repeats d} from the current cursor", () => {
    const ctx = createHandler("one\ntwo\n\nthree\nfour\n\nfive")

    press(ctx, "d")
    press(ctx, "}")
    expect(ctx.textarea.plainText).toBe("\nthree\nfour\n\nfive")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("\nfive")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("dot repeats cw inserted text", () => {
    const ctx = createHandler("hello world")

    press(ctx, "c")
    press(ctx, "w")
    ctx.textarea.insertText("hi")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("hi world")

    ctx.textarea.cursorOffset = 3
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("hi hi")
  })

  test("dot repeats ciw inserted text", () => {
    const ctx = createHandler("hello world")

    press(ctx, "c")
    press(ctx, "i")
    press(ctx, "w")
    ctx.textarea.insertText("hi")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("hi world")

    ctx.textarea.cursorOffset = 3
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("hi hi")
  })

  test("dot repeats ciW inserted text", () => {
    const ctx = createHandler("foo.bar baz.qux")

    press(ctx, "c")
    press(ctx, "i")
    press(ctx, "W")
    ctx.textarea.insertText("hi")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("hi baz.qux")

    ctx.textarea.cursorOffset = 3
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("hi hi")
  })

  test("dot repeats s inserted text", () => {
    const ctx = createHandler("abc def")

    press(ctx, "s")
    ctx.textarea.insertText("x")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("xbc def")

    press(ctx, "w")
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("xbc xef")
  })

  test("dot repeats cw even when inserted text matches deleted word", () => {
    const ctx = createHandler("foo bar")

    press(ctx, "c")
    press(ctx, "w")
    ctx.textarea.insertText("foo")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("foo bar")

    press(ctx, "w")
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("foo foo")
  })

  test("dot repeats cw with no inserted text", () => {
    const ctx = createHandler("one two three")

    press(ctx, "c")
    press(ctx, "w")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe(" two three")

    press(ctx, "w")
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("  three")
  })

  test("dot repeat of cw no-ops when the repeated motion fails", () => {
    const ctx = createHandler("one")

    press(ctx, "c")
    press(ctx, "w")
    ctx.textarea.insertText("X")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("X")

    ctx.textarea.cursorOffset = ctx.textarea.plainText.length
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("X")
    expect(ctx.textarea.cursorOffset).toBe(1)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("dot repeat of cb no-ops when the repeated motion fails", () => {
    const ctx = createHandler("one two")
    ctx.textarea.cursorOffset = 3

    press(ctx, "c")
    press(ctx, "b")
    ctx.textarea.insertText("X")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("X two")

    ctx.textarea.cursorOffset = 0
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("X two")
    expect(ctx.textarea.cursorOffset).toBe(0)
    expect(ctx.state.mode()).toBe("normal")
  })

  test("dot repeats insert text", () => {
    const ctx = createHandler("ab cd")
    ctx.textarea.cursorOffset = 1

    press(ctx, "i")
    ctx.textarea.insertText("XY")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("aXYb cd")

    ctx.textarea.cursorOffset = 5
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("aXYb XYcd")
  })

  test("dot repeats insert through textarea APIs so prompt part offsets move", () => {
    const part: RepeatFilePart = {
      type: "file",
      filename: "a.txt",
      source: { type: "file", path: "a.txt", text: { start: 3, end: 6, value: "[A]" } },
    }
    const ctx = createHandler("ab [A]", { data: [part], snapshotDataEqual: repeatFilePartDataEqual })
    const insertText = ctx.textarea.insertText.bind(ctx.textarea)
    ctx.textarea.insertText = (...args: Parameters<TextareaRenderable["insertText"]>) => {
      const text = args[0]
      const offset = ctx.textarea.cursorOffset
      const result = insertText(...args)
      ctx.setMeta(
        (ctx.meta() as RepeatFilePart[]).map((part) =>
          offset <= part.source.text.start
            ? {
                ...part,
                source: {
                  ...part.source,
                  text: {
                    ...part.source.text,
                    start: part.source.text.start + text.length,
                    end: part.source.text.end + text.length,
                  },
                },
              }
            : part,
        ),
      )
      return result
    }

    press(ctx, "i")
    ctx.textarea.insertText("X")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("Xab [A]")
    expect(ctx.meta()).toEqual([
      {
        type: "file",
        filename: "a.txt",
        source: { type: "file", path: "a.txt", text: { start: 4, end: 7, value: "[A]" } },
      },
    ])

    ctx.textarea.cursorOffset = 2
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("XaXb [A]")
    expect(ctx.meta()).toEqual([
      {
        type: "file",
        filename: "a.txt",
        source: { type: "file", path: "a.txt", text: { start: 5, end: 8, value: "[A]" } },
      },
    ])
  })

  test("dot repeats insert at cursor when inserted text matches neighbor", () => {
    const ctx = createHandler("aba")

    press(ctx, "0")
    press(ctx, "i")
    ctx.textarea.insertText("a")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("aaba")

    press(ctx, "l")
    press(ctx, "l")
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("aaaba")
  })

  test("dot repeats insert backspace replacement", () => {
    const ctx = createHandler("ab cd")
    ctx.textarea.cursorOffset = 1

    press(ctx, "i")
    ctx.textarea.deleteRange(0, 1, 0, 2)
    ctx.textarea.insertText("Xb")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("aXb cd")

    ctx.textarea.cursorOffset = 5
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("aXb cXb")
    expect(ctx.textarea.cursorOffset).toBe(6)
  })

  test("data-changing insert clears dot repeat", () => {
    const ctx = createHandler("abcd", { data: [{ kind: "file", name: "a" }] })

    press(ctx, "x")
    expect(ctx.textarea.plainText).toBe("bcd")

    press(ctx, "i")
    ctx.textarea.insertText("X")
    ctx.setMeta([
      { kind: "file", name: "a" },
      { kind: "file", name: "b" },
    ])
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("Xbcd")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("Xbcd")
    expect(ctx.meta()).toEqual([
      { kind: "file", name: "a" },
      { kind: "file", name: "b" },
    ])
  })

  test("offset-only prompt part data changes preserve dot repeat", () => {
    const part: RepeatFilePart = {
      type: "file",
      filename: "a.txt",
      source: { type: "file", path: "a.txt", text: { start: 5, end: 8, value: "[A]" } },
    }
    const ctx = createHandler("xabc [A]", { data: [part], snapshotDataEqual: repeatFilePartDataEqual })
    const deleteRange = ctx.textarea.deleteRange.bind(ctx.textarea)
    ctx.textarea.deleteRange = (...args: Parameters<TextareaRenderable["deleteRange"]>) => {
      const result = deleteRange(...args)
      ctx.setMeta(
        (ctx.meta() as RepeatFilePart[]).map((part) => ({
          ...part,
          source: {
            ...part.source,
            text: {
              ...part.source.text,
              start: part.source.text.start - 1,
              end: part.source.text.end - 1,
            },
          },
        })),
      )
      return result
    }

    press(ctx, "x")
    expect(ctx.textarea.plainText).toBe("abc [A]")
    expect(ctx.meta()).toEqual([
      {
        type: "file",
        filename: "a.txt",
        source: { type: "file", path: "a.txt", text: { start: 4, end: 7, value: "[A]" } },
      },
    ])

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("bc [A]")
    expect(ctx.meta()).toEqual([
      {
        type: "file",
        filename: "a.txt",
        source: { type: "file", path: "a.txt", text: { start: 3, end: 6, value: "[A]" } },
      },
    ])
  })

  test("semantic prompt part data changes clear dot repeat", () => {
    const ctx = createHandler("abcd", {
      data: [
        {
          type: "file",
          filename: "a.txt",
          source: { type: "file", path: "a.txt", text: { start: 0, end: 3, value: "[A]" } },
        } satisfies RepeatFilePart,
      ],
      snapshotDataEqual: repeatFilePartDataEqual,
    })

    press(ctx, "x")
    expect(ctx.textarea.plainText).toBe("bcd")

    press(ctx, "i")
    ctx.textarea.insertText("X")
    ctx.setMeta([
      {
        type: "file",
        filename: "b.txt",
        source: { type: "file", path: "b.txt", text: { start: 1, end: 4, value: "[B]" } },
      } satisfies RepeatFilePart,
    ])
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("Xbcd")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("Xbcd")
  })

  test("data-changing replay clears dot repeat", () => {
    const ctx = createHandler("abcd", { data: [] })
    const deleteRange = ctx.textarea.deleteRange.bind(ctx.textarea)
    let updateMeta = false
    ctx.textarea.deleteRange = (...args: Parameters<TextareaRenderable["deleteRange"]>) => {
      const result = deleteRange(...args)
      if (updateMeta) ctx.setMeta([{ kind: "file", name: "a" }])
      return result
    }

    press(ctx, "x")
    expect(ctx.textarea.plainText).toBe("bcd")

    updateMeta = true
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("cd")
    expect(ctx.meta()).toEqual([{ kind: "file", name: "a" }])

    updateMeta = false
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("cd")
  })

  test("reset history during active insert restores textarea recorder", () => {
    const ctx = createHandler("abcd")
    const insertText = ctx.textarea.insertText

    press(ctx, "i")
    expect(ctx.textarea.insertText).not.toBe(insertText)

    ctx.state.resetHistory()
    expect(ctx.textarea.insertText).toBe(insertText)
  })

  test("tracks implicit insert sessions", () => {
    const ctx = createHandler("", { mode: "insert" })

    ctx.handler.beginInsertEdit()
    ctx.textarea.insertText("abc")
    press(ctx, "escape")
    press(ctx, "u")
    expect(ctx.textarea.plainText).toBe("")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("abc")
  })

  test("restarts implicit insert tracking after history reset", () => {
    const ctx = createHandler("draft", { mode: "insert" })

    ctx.handler.beginInsertEdit()
    ctx.textarea.insertText("!")
    ctx.state.resetHistory()
    ctx.textarea.setText("")
    ctx.handler.beginInsertEdit()
    ctx.textarea.insertText("abc")
    press(ctx, "escape")
    press(ctx, "u")
    expect(ctx.textarea.plainText).toBe("")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("abc")
  })

  test("finishes implicit insert tracking before external mode changes", () => {
    const ctx = createHandler("", { mode: "insert" })

    ctx.handler.beginInsertEdit()
    ctx.textarea.insertText("abc")
    ctx.handler.finishInsertEdit()
    expect(ctx.textarea.cursorOffset).toBe(2)
    press(ctx, "u")
    expect(ctx.textarea.plainText).toBe("")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("abc")
  })

  test("dot repeats complex insert sessions from the current text", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    press(ctx, "i")
    ctx.textarea.insertText("X")
    ctx.textarea.cursorOffset = 3
    ctx.textarea.insertText("Y")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("aXbYcd")

    ctx.textarea.setText("pqrs")
    ctx.textarea.cursorOffset = 1
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("pXqYrs")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("empty insert clears dot repeat", () => {
    const ctx = createHandler("abcd")

    press(ctx, "x")
    expect(ctx.textarea.plainText).toBe("bcd")

    press(ctx, "i")
    press(ctx, "escape")
    press(ctx, ".")

    expect(ctx.textarea.plainText).toBe("bcd")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("dot repeats blank open line", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1

    press(ctx, "o")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("abc\n")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("abc\n\n")
  })

  test("dot repeats append text", () => {
    const ctx = createHandler("abc")

    press(ctx, "a")
    ctx.textarea.insertText("X")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("aXbc")

    ctx.textarea.cursorOffset = 2
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("aXbXc")
  })

  test("dot repeats append at line end", () => {
    const ctx = createHandler("one\ntwo")

    press(ctx, "A")
    ctx.textarea.insertText("!")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("one!\ntwo")

    ctx.textarea.cursorOffset = 5
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("one!\ntwo!")
  })

  test("dot repeats insert at line start", () => {
    const ctx = createHandler("  one\n  two")
    ctx.textarea.cursorOffset = 4

    press(ctx, "I")
    ctx.textarea.insertText(">")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("  >one\n  two")

    ctx.textarea.cursorOffset = rowColToOffset(ctx.textarea.plainText, 1, 4)
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("  >one\n  >two")
  })

  test("dot repeats substitute line", () => {
    const ctx = createHandler("one\ntwo\nthree")
    ctx.textarea.cursorOffset = 5

    press(ctx, "S")
    ctx.textarea.insertText("X")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("one\nX\nthree")

    ctx.textarea.cursorOffset = rowColToOffset(ctx.textarea.plainText, 2, 1)
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("one\nX\nX")
  })

  test("dot repeats substitute to line end", () => {
    const ctx = createHandler("abc def\nghi jkl")
    ctx.textarea.cursorOffset = 4

    press(ctx, "C")
    ctx.textarea.insertText("X")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("abc X\nghi jkl")

    ctx.textarea.cursorOffset = rowColToOffset(ctx.textarea.plainText, 1, 4)
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("abc X\nghi X")
  })

  test("dot repeats paste", () => {
    const ctx = createHandler("abc")
    ctx.state.setRegister({ text: "X", linewise: false })

    press(ctx, "p")
    expect(ctx.textarea.plainText).toBe("aXbc")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("aXXbc")
  })

  test("dot repeats paste with the original register", () => {
    const ctx = createHandler("abc")
    ctx.state.setRegister({ text: "X", linewise: false })

    press(ctx, "p")
    expect(ctx.textarea.plainText).toBe("aXbc")

    ctx.state.setRegister({ text: "Y", linewise: false })
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("aXXbc")
  })

  test("dot repeats join", () => {
    const ctx = createHandler("one\ntwo\nthree")

    press(ctx, "J")
    expect(ctx.textarea.plainText).toBe("one two\nthree")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("one two three")
  })

  test("dot repeats toggle case", () => {
    const ctx = createHandler("ab")

    press(ctx, "~")
    expect(ctx.textarea.plainText).toBe("Ab")

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("AB")
  })

  test("visual change does not replace dot repeat", () => {
    const ctx = createHandler("abcdef")

    press(ctx, "x")
    expect(ctx.textarea.plainText).toBe("bcdef")

    ctx.textarea.cursorOffset = 1
    press(ctx, "v")
    press(ctx, "l")
    press(ctx, "c")
    ctx.textarea.insertText("Q")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("bQef")

    ctx.textarea.cursorOffset = 0
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("Qef")
  })

  test("dot repeats replace character", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    press(ctx, "r")
    press(ctx, "X")
    expect(ctx.textarea.plainText).toBe("aXcd")

    ctx.textarea.cursorOffset = 2
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("aXXd")
  })

  test("dot repeats replace even when first replacement is same character", () => {
    const ctx = createHandler("ab")

    press(ctx, "0")
    press(ctx, "r")
    press(ctx, "a")
    expect(ctx.textarea.plainText).toBe("ab")

    press(ctx, "l")
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("aa")
  })

  test("dot repeats replace mode even when first replacement is same character", () => {
    const ctx = createHandler("ab")

    press(ctx, "0")
    press(ctx, "R", { shift: true })
    press(ctx, "a")
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("ab")

    press(ctx, "l")
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("aa")
  })

  test("dot repeats replace mode changed text", () => {
    const ctx = createHandler("ab")

    press(ctx, "0")
    press(ctx, "R", { shift: true })
    press(ctx, "X", { shift: true })
    press(ctx, "escape")
    expect(ctx.textarea.plainText).toBe("Xb")

    press(ctx, "l")
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("XX")
  })

  test("yank and motion do not replace dot repeat", () => {
    const ctx = createHandler("abcd ef")

    press(ctx, "x")
    expect(ctx.textarea.plainText).toBe("bcd ef")
    press(ctx, "w")
    press(ctx, "y")
    press(ctx, "w")
    ctx.textarea.cursorOffset = 0

    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("cd ef")
  })

  test("dot with no repeat is consumed", () => {
    const ctx = createHandler("abc")
    const dot = createEvent(".")

    expect(ctx.handler.handleKey(dot.event)).toBe(true)
    expect(dot.prevented()).toBe(true)
    expect(ctx.textarea.plainText).toBe("abc")
  })

  test("u after dot undoes only the repeated change", () => {
    const ctx = createHandler("abcd")

    press(ctx, "x")
    press(ctx, ".")
    expect(ctx.textarea.plainText).toBe("cd")

    press(ctx, "u")
    expect(ctx.textarea.plainText).toBe("bcd")
  })
})

describe("vim undo redo", () => {
  test("u undoes and ctrl+r redoes normal mode edits", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("x").event)
    expect(ctx.textarea.plainText).toBe("acd")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("abcd")
    expect(ctx.textarea.cursorOffset).toBe(1)

    ctx.handler.handleKey(createEvent("r", { ctrl: true }).event)
    expect(ctx.textarea.plainText).toBe("acd")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("insert session undoes in one step", () => {
    const ctx = createHandler("ab")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("i").event)
    expect(ctx.state.mode()).toBe("insert")
    ctx.textarea.insertText("X")
    ctx.textarea.insertText("Y")
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("aXYb")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("ab")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("replace session undoes in one step", () => {
    const ctx = createHandler("abcd")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("R", { shift: true }).event)
    expect(ctx.state.mode()).toBe("replace")
    ctx.handler.handleKey(createEvent("X").event)
    ctx.handler.handleKey(createEvent("Y").event)
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("aXYd")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("abcd")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("multiple undo steps work across insert sessions", () => {
    const ctx = createHandler("")

    ctx.handler.handleKey(createEvent("i").event)
    ctx.textarea.insertText("hello")
    ctx.handler.handleKey(createEvent("escape").event)

    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("escape").event)

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("")

    ctx.handler.handleKey(createEvent("r", { ctrl: true }).event)
    expect(ctx.textarea.plainText).toBe("hello")

    ctx.handler.handleKey(createEvent("i").event)
    ctx.textarea.insertText("hello2")
    ctx.handler.handleKey(createEvent("escape").event)

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("hello")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("")
  })

  test("open line and typed text undo together", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1

    ctx.handler.handleKey(createEvent("o").event)
    expect(ctx.state.mode()).toBe("insert")
    ctx.textarea.insertText("hello")
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("abc\nhello")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("abc")
    expect(ctx.textarea.cursorOffset).toBe(1)
  })

  test("undo restores structured snapshot data", () => {
    const ctx = createHandler("abc", { data: [{ kind: "file", name: "a" }] })
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("i").event)
    ctx.textarea.insertText("x")
    ctx.setMeta([
      { kind: "file", name: "a" },
      { kind: "file", name: "b" },
    ])
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("abcx")
    expect(ctx.meta()).toEqual([
      { kind: "file", name: "a" },
      { kind: "file", name: "b" },
    ])

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("abc")
    expect(ctx.meta()).toEqual([{ kind: "file", name: "a" }])

    ctx.handler.handleKey(createEvent("r", { ctrl: true }).event)
    expect(ctx.textarea.plainText).toBe("abcx")
    expect(ctx.meta()).toEqual([
      { kind: "file", name: "a" },
      { kind: "file", name: "b" },
    ])
  })

  test("undo and redo restore every PromptInfo metadata field", () => {
    const before: PromptInfo = {
      text: "@a.ts @build @review [Pasted]",
      files: [{ uri: "file:///a.ts", name: "a.ts", mention: { start: 0, end: 5, text: "@a.ts" } }],
      agents: [{ name: "build", mention: { start: 6, end: 12, text: "@build" } }],
      skills: [{ id: Skill.ID.make("review"), mention: { start: 13, end: 20, text: "@review" } }],
      pasted: [{ text: "expanded", source: { start: 21, end: 29, text: "[Pasted]" } }],
    }
    const after: PromptInfo = {
      ...structuredClone(before),
      text: `${before.text}!`,
      files: [...(before.files ?? []), { uri: "file:///b.ts", name: "b.ts" }],
      agents: [...(before.agents ?? []), { name: "plan" }],
      skills: [...(before.skills ?? []), { id: Skill.ID.make("test") }],
      pasted: [...before.pasted, { text: "more", source: { start: 30, end: 38, text: "[Pasted]" } }],
    }
    const ctx = createHandler(before.text, { data: before })
    ctx.textarea.cursorOffset = before.text.length

    ctx.handler.handleKey(createEvent("i").event)
    ctx.textarea.insertText("!")
    ctx.setMeta(after)
    ctx.handler.handleKey(createEvent("escape").event)

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe(before.text)
    expect(ctx.meta()).toEqual(before)

    ctx.handler.handleKey(createEvent("r", { ctrl: true }).event)
    expect(ctx.textarea.plainText).toBe(after.text)
    expect(ctx.meta()).toEqual(after)
  })

  test("empty insert sessions do not create undo entries", () => {
    const ctx = createHandler("hello")
    ctx.textarea.cursorOffset = 5

    ctx.handler.handleKey(createEvent("i").event)
    ctx.handler.handleKey(createEvent("escape").event)

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("hello")
    expect(ctx.textarea.cursorOffset).toBe(4)
  })

  test("redo is cleared after a new edit", () => {
    const ctx = createHandler("")

    ctx.handler.handleKey(createEvent("i").event)
    ctx.textarea.insertText("hello")
    ctx.handler.handleKey(createEvent("escape").event)

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("")

    ctx.handler.handleKey(createEvent("i").event)
    ctx.textarea.insertText("world")
    ctx.handler.handleKey(createEvent("escape").event)
    expect(ctx.textarea.plainText).toBe("world")

    ctx.handler.handleKey(createEvent("r", { ctrl: true }).event)
    expect(ctx.textarea.plainText).toBe("world")
  })

  test("cw groups delete and insert into one undo step", () => {
    const ctx = createHandler("hello world")

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("w").event)
    expect(ctx.state.mode()).toBe("insert")
    ctx.textarea.insertText("hi")
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("hi world")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.textarea.cursorOffset).toBe(0)
  })

  test("cc groups clear and insert into one undo step", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("c").event)
    ctx.handler.handleKey(createEvent("c").event)
    expect(ctx.state.mode()).toBe("insert")
    ctx.textarea.insertText("hi")
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("hi")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("S groups substitute line and insert into one undo step", () => {
    const ctx = createHandler("hello world")
    ctx.textarea.cursorOffset = 3

    ctx.handler.handleKey(createEvent("S", { shift: true }).event)
    expect(ctx.state.mode()).toBe("insert")
    ctx.textarea.insertText("hi")
    ctx.handler.handleKey(createEvent("escape").event)

    expect(ctx.textarea.plainText).toBe("hi")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("hello world")
    expect(ctx.textarea.cursorOffset).toBe(3)
  })

  test("p undo and redo work", () => {
    const ctx = createHandler("abc")
    ctx.textarea.cursorOffset = 1
    ctx.state.setRegister({ text: "XY", linewise: false })

    ctx.handler.handleKey(createEvent("p").event)
    expect(ctx.textarea.plainText).toBe("abXYc")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("abc")

    ctx.handler.handleKey(createEvent("r", { ctrl: true }).event)
    expect(ctx.textarea.plainText).toBe("abXYc")
  })

  test("J undo and redo work", () => {
    const ctx = createHandler("one\ntwo")

    ctx.handler.handleKey(createEvent("J", { shift: true }).event)
    expect(ctx.textarea.plainText).toBe("one two")

    ctx.handler.handleKey(createEvent("u").event)
    expect(ctx.textarea.plainText).toBe("one\ntwo")

    ctx.handler.handleKey(createEvent("r", { ctrl: true }).event)
    expect(ctx.textarea.plainText).toBe("one two")
  })

  test("wrapped logical line motions stay on same logical line", () => {
    const ctx = createHandler("this is a very long logical line without a newline")
    ctx.textarea.cursorOffset = 10

    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.textarea.cursorOffset).toBe(10)

    ctx.handler.handleKey(createEvent("k").event)
    expect(ctx.textarea.cursorOffset).toBe(10)

    ctx.handler.handleKey(createEvent("$").event)
    expect(ctx.textarea.cursorOffset).toBe(ctx.textarea.plainText.length - 1)
  })
})

describe("transcript copy mode", () => {
  test("applies counts to vertical movement", () => {
    const ctx = createHandler("copy", { mode: "copy" })
    ctx.handler.handleKey(createEvent("3").event)
    ctx.handler.handleKey(createEvent("j").event)
    expect(ctx.copyMoves).toEqual(["down", "down", "down"])
  })

  test("supports line, word, paragraph, bracket, and find motions", () => {
    const line = createHandler("  alpha beta", { mode: "copy", copy: { text: "  alpha beta", col: 4 } })
    line.handler.handleKey(createEvent("0").event)
    expect(line.copyCol()).toBe(0)
    line.handler.handleKey(createEvent("$").event)
    expect(line.copyCol()).toBe(11)
    line.handler.handleKey(createEvent("^").event)
    expect(line.copyCol()).toBe(2)
    line.handler.handleKey(createEvent("w").event)
    expect(line.copyCol()).toBe(8)
    line.handler.handleKey(createEvent("f").event)
    line.handler.handleKey(createEvent("t").event)
    expect(line.copyCol()).toBe(10)

    const find = createHandler("alpha beta gamma", {
      mode: "copy",
      copy: { text: "alpha beta gamma", col: 0 },
    })
    find.handler.handleKey(createEvent("2").event)
    find.handler.handleKey(createEvent("f").event)
    find.handler.handleKey(createEvent("a").event)
    expect(find.copyCol()).toBe(9)

    const rows = {
      idx: 0,
      col: 4,
      rows: [{ col: 0 }, { col: 0 }, { col: 0 }, { col: 0 }],
      texts: ["call(", "", "value", ")"],
    }
    const transcript = createHandler("copy", { mode: "copy", copy: rows })
    transcript.handler.handleKey(createEvent("%").event)
    expect(transcript.copyIdx()).toBe(3)
    transcript.handler.handleKey(createEvent("{").event)
    expect(transcript.copyIdx()).toBe(1)
  })

  test("supports visual modes, yanks, search, and ctrl scrolling", () => {
    const ctx = createHandler("copy", { mode: "copy", copy: { text: "picked" } })
    ctx.handler.handleKey(createEvent("v").event)
    expect(ctx.copyVisualCalls).toEqual(["char"])
    expect(ctx.copyYanks()).toBe(0)
    expect(ctx.copyYankLines()).toBe(0)
    ctx.handler.handleKey(createEvent("y").event)
    expect(ctx.copyYanks()).toBe(1)

    const search = createHandler("copy", { mode: "copy" })
    search.handler.handleKey(createEvent("/").event)
    search.handler.handleKey(createEvent("a").event)
    search.handler.handleKey(createEvent("return").event)
    expect(search.copySearchCalls).toEqual(["forward"])
    expect(search.copySearchAppends).toEqual(["a"])
    expect(search.copySearchSubmits()).toBe(1)

    search.handler.handleKey(createEvent("d", { ctrl: true }).event)
    search.handler.handleKey(createEvent("u", { ctrl: true }).event)
    search.handler.handleKey(createEvent("f", { ctrl: true }).event)
    expect(search.copyHalfPages).toEqual(["down", "up"])
    expect(search.scrollCalls).toEqual(["page-down"])
  })
})

describe("vim scroll mapping", () => {
  test("vimScroll maps ctrl keys to actions", () => {
    expect(vimScroll(createEvent("e", { ctrl: true }).event)).toBe("line-down")
    expect(vimScroll(createEvent("y", { ctrl: true }).event)).toBe("line-up")
    expect(vimScroll(createEvent("d", { ctrl: true }).event)).toBe("half-down")
    expect(vimScroll(createEvent("u", { ctrl: true }).event)).toBe("half-up")
    expect(vimScroll(createEvent("f", { ctrl: true }).event)).toBe("page-down")
    expect(vimScroll(createEvent("b", { ctrl: true }).event)).toBe("page-up")
    expect(vimScroll(createEvent("b", { ctrl: true, meta: true }).event)).toBe(undefined)
    expect(vimScroll(createEvent("b", { ctrl: false }).event)).toBe(undefined)
  })
})

describe("copy layout anchors", () => {
  test("growth above the cursor does not redirect a yank to a different child", () => {
    createRoot((dispose) => {
      const text = (plainText: string) => ({
        plainText,
        height: 1,
        lineInfo: { lineSources: [0], lineStartCols: [0], lineWidthCols: [plainText.length] },
        getLayout: () => ({ top: 0, left: 0 }),
        getChildren: () => [],
      })
      const first = text("alpha")
      const target = text("TARGET")
      const children = [
        { id: "first", y: 0, height: 1, getChildren: () => [first] },
        { id: "target", y: 1, height: 1, getChildren: () => [target] },
      ]
      const copy = createCopyMode({
        scroll: () =>
          ({
            y: 0,
            width: 80,
            height: 20,
            scrollHeight: 3,
            getChildren: () => children,
            scrollBy() {},
            scrollTo() {},
          }) as unknown as ScrollBoxRenderable,
        targets: () =>
          children.map((child) => ({ key: child.id, id: child.id, role: "assistant", kind: "text", col: 0 })),
        session: () => "layout",
        toBottom() {},
        write: async () => {},
      })
      try {
        copy.prompt.enter()
        copy.prompt.jump("bottom")
        expect(copy.prompt.yankLine()?.text).toBe("TARGET")
        first.plainText = "alpha\nINSERTED"
        first.height = 2
        first.lineInfo = { lineSources: [0, 1], lineStartCols: [0, 0], lineWidthCols: [5, 8] }
        children[0]!.height = 2
        children[1]!.y = 2
        expect(copy.prompt.yankLine()?.text).toBe("TARGET")
        copy.refresh()
        expect(copy.row()?.id).toBe("target")
      } finally {
        dispose()
      }
    })
  })

  test("a selection keeps its logical text after the selected line rewraps", () => {
    createRoot((dispose) => {
      const node = {
        plainText: "0123456789TARGET",
        height: 2,
        lineInfo: { lineSources: [0, 0], lineStartCols: [0, 10], lineWidthCols: [10, 6] },
        getLayout: () => ({ top: 0, left: 0 }),
        getChildren: () => [],
      }
      const child = { id: "wrapped", y: 0, height: 2, getChildren: () => [node] }
      const copy = createCopyMode({
        scroll: () =>
          ({
            y: 0,
            width: 80,
            height: 20,
            scrollHeight: 4,
            getChildren: () => [child],
            scrollBy() {},
            scrollTo() {},
          }) as unknown as ScrollBoxRenderable,
        targets: () => [{ key: "wrapped", id: "wrapped", role: "assistant", kind: "text", col: 0 }],
        session: () => "layout",
        toBottom() {},
        write: async () => {},
      })
      try {
        copy.prompt.enter()
        copy.prompt.jump("bottom")
        copy.prompt.setCol(0)
        copy.prompt.visual("char")
        copy.prompt.setCol(5)
        expect(copy.prompt.yank()?.text).toBe("TARGET")
        node.height = 4
        child.height = 4
        node.lineInfo = { lineSources: [0, 0, 0, 0], lineStartCols: [0, 5, 10, 15], lineWidthCols: [5, 5, 5, 1] }
        expect(copy.prompt.yank()?.text).toBe("TARGET")
        copy.refresh()
        expect(copy.cursorText()).toBe("T")
        expect(
          [...copy.highlights().values()]
            .flat()
            .map((highlight) => highlight.text)
            .join(""),
        ).toBe("TARGE")
      } finally {
        dispose()
      }
    })
  })
})
