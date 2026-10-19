import type { Accessor } from "solid-js"
import type { createVimState, VimRegister, VimSnapshot } from "./vim-state"
import type { TextareaRenderable } from "@opentui/core"
import { vimScroll, type VimScroll } from "./vim-scroll"
import { vimJump, type VimJump } from "./vim-motion-jump"
import { vimWindowNavigation, type VimWindowNavigation } from "./vim-motion-window-navigation"
import { createVimRepeat } from "./vim-repeat"
import {
  appendAfterCursor,
  appendLineEnd,
  alignVisualColumn,
  clampCursorToLine,
  clearSelection,
  deleteLine,
  deleteLineEnd,
  deleteSelection,
  deleteSpan,
  deleteUnderCursor,
  findCharInLine,
  findCharTargetInLine,
  firstNonWhitespace,
  firstNonWhitespaceOperation,
  getLineColumn,
  insertLineStart,
  joinLines,
  lineBeginningOperation,
  lineEnd as lineEndOffset,
  lineStart as lineStartOffset,
  matchingBracketOperation,
  matchingBracketTarget,
  moveBigWordEnd,
  moveBigWordNext,
  moveBigWordPrev,
  moveFirstNonWhitespace,
  moveLeft,
  moveLineBeginning,
  moveLineDown,
  moveLineUp,
  moveVisualFirstNonWhitespace,
  moveVisualLineBeginning,
  moveVisualLineDown,
  moveVisualLineEnd,
  moveVisualLineUp,
  moveMatchingBracket,
  moveNextParagraph,
  movePreviousParagraph,
  moveRight,
  moveLineEnd,
  moveWordEnd,
  moveWordNext,
  moveWordPrev,
  nextParagraphOperation,
  nextWordStart,
  openLineAbove,
  openLineBelow,
  type VimOperator,
  type VimOperatorResult,
  type VimSpan,
  type VimWantedColumn,
  pasteAfter,
  pasteBefore,
  pasteOverSelection,
  pasteOverVisualSelection,
  previousParagraphOperation,
  bracketTextObjectOperation,
  quoteTextObjectOperation,
  prevWordStart,
  replaceUnderCursor,
  replaceSelection,
  substituteLine,
  substituteLineEnd,
  syncSelection,
  toggleVisualEnd,
  toggleCase,
  toggleSelectionCase,
  wordEnd,
  wordTextObjectOperation,
  yankSelection,
} from "./vim-motions"
import { applyLangmap } from "./vim-langmap"

export type VimEvent = {
  name?: string
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
  super?: boolean
  sequence?: string
  raw?: string
  preventDefault: () => void
}

export type VimCopyMove = "up" | "down" | "left" | "right"
type VimFindOperator = "f" | "F" | "t" | "T"
type VimSearchDirection = "forward" | "backward"
type VimTextObjectScope = "inner" | "around"

type VimKeyLike = { name?: string; shift?: boolean; sequence?: string; raw?: string }
type VimLineMotions = "logical" | "display_vertical" | "display"

export function vimLangmapKeyName(event: VimKeyLike) {
  return vimEventText(event) ?? normalizedKeyName(event)
}

function vimEventText(event: VimKeyLike) {
  return event.sequence?.length === 1 ? event.sequence : event.raw?.length === 1 ? event.raw : undefined
}

function normalizedKeyName(event: VimKeyLike) {
  if (event.name === "backspace" || event.sequence === "\b" || event.sequence === "\x7f" || event.raw === "\b" || event.raw === "\x7f") return "backspace"
  if (event.name === "enter") return "return"
  if (event.name === "slash") return event.shift ? "?" : "/"
  if (event.name === "colon") return ":"
  if (event.name === "at") return "@"
  if (event.name === "quote") return '"'
  if (event.name === "apostrophe") return "'"
  if (event.name === "backtick") return "`"
  const text = vimEventText(event)
  if (
    text &&
    (text === ":" ||
      text === "/" ||
      text === "?" ||
      text === "@" ||
      text === '"' ||
      text === "'" ||
      text === "`" ||
      "()[]{}<>".includes(text))
  )
    return text
  if (event.shift) {
    if (event.name === "4") return "$"
    if (event.name === "6") return "^"
    if (event.name === "9") return "("
    if (event.name === "0") return ")"
    if (event.name === "[") return "{"
    if (event.name === "]") return "}"
    if (event.name === ",") return "<"
    if (event.name === ".") return ">"
    if (event.name === ";") return ":"
  }
  return event.name ?? ""
}

export function createVimHandler(input: {
  enabled: Accessor<boolean>
  state: ReturnType<typeof createVimState>
  textarea: Accessor<TextareaRenderable>
  submit: () => void
  commandPalette?: () => void
  scroll: (action: VimScroll) => void
  jump: (action: VimJump) => void
  navigate?: (action: VimWindowNavigation) => void
  // NOTE: This vim core is shared between the opencode-vim fork
  // (https://github.com/leohenon/opencode-vim) and the opencode-vim-plugin
  // (https://github.com/leohenon/opencode-vim-plugin).
  // The copy* callbacks below and the "copy" mode dispatch path are not wired up the plugin.
  // Do not remove — keeping the files identical makes porting changes trivial.
  copy?: (action: VimCopyMove) => void
  copyVisual?: (mode: "char" | "line" | "block") => void
  copyExitVisual?: () => void
  copyExit?: (scrollToBottom?: boolean) => void
  copyExitPreserveScroll?: () => void
  copyFocusInput?: () => void
  copyYank?: () => void
  copyYankLine?: () => void
  copyYankMatchingBracket?: () => boolean
  copyToggleVisualEnd?: () => void
  copyCopy?: () => void
  copyToggleCollapsed?: () => boolean
  copyActivate?: () => boolean
  copyIsVisual?: () => boolean
  copyHalfPage?: (direction: "up" | "down") => void
  copyJump?: (action: VimJump) => void
  copyWordNext?: (big: boolean) => boolean
  copyWordPrev?: (big: boolean) => boolean
  copyWordEnd?: (big: boolean) => boolean
  copyMatchingBracket?: () => boolean
  copyNextParagraph?: () => boolean
  copyPreviousParagraph?: () => boolean
  copySearchStart?: (direction: VimSearchDirection) => boolean | void
  copySearchAppend?: (value: string) => boolean
  copySearchBackspace?: () => boolean
  copySearchSubmit?: () => boolean
  copySearchCancel?: () => void
  copySearchClear?: () => boolean
  copySearchActive?: () => boolean
  copySearchHighlighted?: () => boolean
  copySearchNext?: () => boolean
  copySearchPrevious?: () => boolean
  copyText?: () => string
  copyCol?: () => number
  setCopyCol?: (offset: number) => void
  setCopyStick?: (stick: "start" | "first" | "end") => void
  copyScroll?: (action: "center" | "top" | "bottom") => void
  autocomplete?: () => false | "@" | "/"
  flash?: (span: { start: number; end: number }) => void
  history?: () => boolean
  snapshot?: () => VimSnapshot
  snapshotDataEqual?: (before: unknown, after: unknown) => boolean
  restore?: (next: VimSnapshot) => void
  register?: () => VimRegister
  setRegister?: (register: VimRegister, notify?: boolean) => void
  pasteOverSelection?: () => boolean
  langmap?: Accessor<Record<string, string> | undefined>
  vimLineMotions?: Accessor<VimLineMotions | undefined>
  vimEscapeSequence?: string
}) {
  let wantedColumn: VimWantedColumn | undefined
  let visualWantedColumn: VimWantedColumn | undefined
  let pendingOperatorCount = 1
  let pendingOperatorFind: { operation: VimOperator; find: VimFindOperator } | undefined
  let pendingOperatorDisplay: VimOperator | undefined
  let pendingTextObject: { operation: VimOperator; scope: VimTextObjectScope } | undefined

  // Two-key escape sequence support (e.g., "jk" to escape insert mode)
  const escapeSeq = input.vimEscapeSequence
  const escapeFirst = escapeSeq?.[0]
  const escapeSecond = escapeSeq?.[1]
  let escapePending = false
  let escapeTimer: ReturnType<typeof setTimeout> | null = null

  function clearEscapePending() {
    escapePending = false
    if (escapeTimer) {
      clearTimeout(escapeTimer)
      escapeTimer = null
    }
  }

  function hasModifier(event: VimEvent) {
    return !!event.ctrl || !!event.meta || !!event.super
  }

  function lineMotions() {
    return input.vimLineMotions?.() ?? "logical"
  }

  function displayVerticalLineMotions() {
    const mode = lineMotions()
    return mode === "display_vertical" || mode === "display"
  }

  function displayLineBoundaryMotions() {
    return lineMotions() === "display"
  }

  function isPrintable(event: VimEvent) {
    const key = normalizedKeyName(event)
    return key.length === 1 || key === "space"
  }

  function value(event: VimEvent) {
    const key = normalizedKeyName(event)
    if (key === "space") return " "
    if (event.shift && key.length === 1 && /[a-z]/.test(key)) return key.toUpperCase()
    return key
  }

  function replaceValue(event: VimEvent, visual = false) {
    if (event.name === "return") return visual ? "\r" : "\n"
    if (isPrintable(event)) return value(event)
    return null
  }

  function langmapped(event: VimEvent) {
    if (hasModifier(event)) return event
    if (["r", "vr", "f", "F", "t", "T"].includes(input.state.pending())) return event
    return applyLangmap(event, vimLangmapKeyName(event), input.langmap?.())
  }

  function isShifted(event: VimEvent, key: string) {
    return event.name === key.toUpperCase() || (event.name === key && !!event.shift)
  }

  function tracked() {
    return input.history?.() ?? true
  }

  function register() {
    if (input.register) return input.register()
    return input.state.register()
  }

  function setRegister(next: VimRegister, notify = false) {
    if (input.setRegister) {
      input.setRegister(next, notify)
      return
    }
    input.state.setRegister(next)
  }

  function clearWantedColumn() {
    wantedColumn = undefined
  }

  function clearVisualWantedColumn() {
    visualWantedColumn = undefined
  }

  function repeatCount(count: number, run: () => void) {
    Array.from({ length: count }).forEach(() => run())
  }

  function takeCount(defaultValue = 1) {
    return input.state.takeCount(defaultValue)
  }

  function takeOperatorCount() {
    const count = takeCount(pendingOperatorCount)
    pendingOperatorCount = 1
    return count
  }

  function countedMotion(run: () => void) {
    repeatCount(takeCount(), run)
  }

  function isCountDigit(event: VimEvent, key: string) {
    return !event.shift && !hasModifier(event) && /^[1-9]$/.test(key)
  }

  function isCountInput(event: VimEvent, key: string) {
    return !input.state.pending() && (isCountDigit(event, key) || (key === "0" && input.state.count()))
  }

  function isPendingOperatorCountInput(event: VimEvent, key: string) {
    return (
      pendingOperatorCount === 1 &&
      (input.state.pending() === "c" || input.state.pending() === "d" || input.state.pending() === "y") &&
      (isCountDigit(event, key) || (key === "0" && input.state.count()))
    )
  }

  function startOperator(event: VimEvent, operation: VimOperator) {
    const display = input.state.count() + operation
    pendingOperatorCount = takeCount()
    input.state.setPending(operation, display)
    event.preventDefault()
    return true
  }

  function lineStartForCount(text: string, offset: number, count: number) {
    return Array.from({ length: count - 1 }).reduce<number>((current) => {
      const end = lineEndOffset(text, current)
      return end >= text.length ? current : end + 1
    }, offset)
  }

  function moveVertical(direction: "up" | "down") {
    const column = wantedColumn ?? getLineColumn(input.textarea())
    if (direction === "up") moveLineUp(input.textarea(), column)
    else moveLineDown(input.textarea(), column)
    wantedColumn = column
  }

  function preservesWantedColumn(event: VimEvent, key: string) {
    if (key === "g" && !event.shift && !hasModifier(event)) return true
    if ((key === "j" || key === "k" || key === "down" || key === "up") && !event.shift && !hasModifier(event))
      return true
    return (key === "v" || isShifted(event, "v")) && !hasModifier(event)
  }

  function preservesVisualWantedColumn(event: VimEvent, key: string) {
    if (key === "g" && !event.shift && !hasModifier(event)) return true
    if (
      displayVerticalLineMotions() &&
      (key === "j" || key === "k" || key === "down" || key === "up") &&
      !event.shift &&
      !hasModifier(event)
    )
      return true
    return (
      input.state.pending() === "g" &&
      (key === "j" || key === "k" || key === "down" || key === "up") &&
      !event.shift &&
      !hasModifier(event)
    )
  }

  function snapshot(): VimSnapshot {
    if (input.snapshot) return input.snapshot()
    return {
      text: input.textarea().plainText,
      cursor: input.textarea().cursorOffset,
    }
  }

  function restore(next: VimSnapshot) {
    clearWantedColumn()
    clearVisualWantedColumn()
    clearSelection(input.textarea())
    input.state.clearPending()
    input.state.setMode("normal")
    input.state.cancelEdit()
    if (input.restore) {
      input.restore(next)
      return
    }
    input.textarea().setText(next.text)
    input.textarea().cursorOffset = Math.max(0, Math.min(next.cursor, next.text.length))
  }

  const repeat = createVimRepeat({
    state: input.state,
    textarea: input.textarea,
    snapshot,
    snapshotDataEqual: input.snapshotDataEqual,
    tracked,
  })
  const edit = repeat.edit
  const begin = repeat.begin

  function finishInsertEdit() {
    input.state.setMode("normal")
    input.state.commitEdit(snapshot())
    moveLeft(input.textarea())
    repeat.commit(snapshot())
  }

  function applyOperatorYank(result: VimOperatorResult) {
    if (result.register) setRegister(result.register, true)
    if (result.span && result.span.end > result.span.start) input.flash?.(result.span)
    input.state.clearPending()
  }

  function applyOperatorEdit(result: () => VimOperatorResult, operation: "d" | "c") {
    const apply = () => {
      const next = result()
      if (!next.span && !next.register) {
        input.state.clearPending()
        return false
      }
      if (next.span && next.span.end > next.span.start) deleteSpan(input.textarea(), next.span)
      if (next.span && next.span.end === next.span.start) input.textarea().cursorOffset = next.span.start
      if (next.register) setRegister(next.register)
      input.state.clearPending()
      if (operation === "c") input.state.setMode("insert")
      return true
    }
    if (operation === "c") begin(apply)
    else edit(apply)
  }

  function applyOperatorResult(result: () => VimOperatorResult, operation: VimOperator) {
    const initial = result()

    // no motion: vim no-ops the operator without editing or changing mode.
    if (!initial.span && !initial.register) {
      input.state.clearPending()
      return
    }
    if (operation === "y") {
      applyOperatorYank(initial)
      return
    }
    applyOperatorEdit(result, operation)
  }

  function paragraphOperator(key: string, operation: VimOperator): boolean {
    if (key !== "{" && key !== "}") return false

    const count = takeOperatorCount()
    applyOperatorResult(
      () =>
        key === "}" ? nextParagraphCountOperation(operation, count) : previousParagraphCountOperation(operation, count),
      operation,
    )

    return true
  }

  function matchingBracketOperator(key: string, operation: VimOperator): boolean {
    if (key !== "%") return false

    pendingOperatorCount = 1
    applyOperatorResult(() => matchingBracketOperation(input.textarea()), operation)

    return true
  }

  function charwiseOperation(span: VimSpan | null): VimOperatorResult {
    if (!span) return { span: null, register: null }
    return { span, register: { text: input.textarea().plainText.slice(span.start, span.end), linewise: false } }
  }

  function linewiseOperation(span: VimSpan | null): VimOperatorResult {
    if (!span) return { span: null, register: null }
    const text = input.textarea().plainText.slice(span.start, span.end)
    return { span, register: { text: text.endsWith("\n") ? text : text + "\n", linewise: true } }
  }

  function nextParagraphCountOperation(operation: VimOperator, count: number) {
    if (count === 1) return nextParagraphOperation(input.textarea(), operation)
    const textarea = input.textarea()
    const cursor = textarea.cursorOffset
    repeatCount(count - 1, () => moveNextParagraph(textarea))
    const next = nextParagraphOperation(textarea, operation)
    textarea.cursorOffset = cursor
    if (!next.span) return next
    return next.register?.linewise
      ? linewiseOperation({ start: lineStartOffset(textarea.plainText, cursor), end: next.span.end })
      : charwiseOperation({ start: cursor, end: next.span.end })
  }

  function previousParagraphCountOperation(operation: VimOperator, count: number) {
    if (count === 1) return previousParagraphOperation(input.textarea(), operation)
    const textarea = input.textarea()
    const cursor = textarea.cursorOffset
    repeatCount(count - 1, () => movePreviousParagraph(textarea))
    const next = previousParagraphOperation(textarea, operation)
    textarea.cursorOffset = cursor
    if (!next.span) return next
    if (!next.register?.linewise) return charwiseOperation({ start: next.span.start, end: cursor })
    const end = operation === "c" && textarea.plainText[cursor - 1] === "\n" ? cursor - 1 : cursor
    return linewiseOperation(end > next.span.start ? { start: next.span.start, end } : null)
  }

  function nextWordOperation(big: boolean, count = 1) {
    const textarea = input.textarea()
    const start = textarea.cursorOffset
    const end = Array.from({ length: count }).reduce<number>(
      (offset) => nextWordStart(textarea.plainText, offset, big),
      start,
    )
    return charwiseOperation(end > start ? { start, end } : null)
  }

  function previousWordOperation(count = 1) {
    const textarea = input.textarea()
    const end = textarea.cursorOffset
    const start = Array.from({ length: count }).reduce<number>(
      (offset) => prevWordStart(textarea.plainText, offset, false),
      end,
    )
    return charwiseOperation(start < end ? { start, end } : null)
  }

  function wordEndOperation(big: boolean, count = 1) {
    const textarea = input.textarea()
    const start = textarea.cursorOffset
    if (start >= textarea.plainText.length) return charwiseOperation(null)
    const end = Array.from({ length: count }).reduce<number>(
      (offset) => wordEnd(textarea.plainText, offset, big) + 1,
      start,
    )
    return charwiseOperation(end > start ? { start, end } : null)
  }

  function lineSpanCount(count: number) {
    const textarea = input.textarea()
    const start = lineStartOffset(textarea.plainText, textarea.cursorOffset)
    const target = lineStartForCount(textarea.plainText, textarea.cursorOffset, count)
    return { start, end: lineEndOffset(textarea.plainText, target) }
  }

  function yankLineCount(count: number) {
    const span = lineSpanCount(count)
    return { span, register: { text: input.textarea().plainText.slice(span.start, span.end), linewise: true } }
  }

  function deleteLineCount(count: number) {
    const textarea = input.textarea()
    const start = textarea.cursorOffset
    repeatCount(count - 1, () => moveLineDown(textarea, 0))
    const anchor = textarea.cursorOffset
    textarea.cursorOffset = start
    return deleteLine(textarea, anchor)
  }

  function substituteLineCount(count: number) {
    const textarea = input.textarea()
    const start = textarea.cursorOffset
    repeatCount(count - 1, () => moveLineDown(textarea, 0))
    const anchor = textarea.cursorOffset
    textarea.cursorOffset = start
    return substituteLine(textarea, anchor)
  }

  function prepareDisplayWantedColumn() {
    const view = input.textarea().editorView as { getVisualCursor?: () => { visualCol: number } }
    visualWantedColumn ??= wantedColumn === "end" ? "end" : view.getVisualCursor?.().visualCol
    clearWantedColumn()
  }

  function moveDisplayVertical(direction: "up" | "down", count: number, column: VimWantedColumn | undefined) {
    repeatCount(count, () => {
      direction === "down" ? moveVisualLineDown(input.textarea()) : moveVisualLineUp(input.textarea())
      // Native visual moves can land on trailing newlines.
      clampCursorToLine(input.textarea())
      if (column === "end") moveVisualLineEnd(input.textarea())
      else if (column !== undefined) alignVisualColumn(input.textarea(), column)
    })
  }

  function moveDisplayHorizontal(key: string, count: number) {
    const textarea = input.textarea()
    if (key === "$") repeatCount(count - 1, () => moveDisplayVertical("down", 1, undefined))
    if (key === "0") moveVisualLineBeginning(textarea)
    else if (key === "^") moveVisualFirstNonWhitespace(textarea)
    else moveVisualLineEnd(textarea)
  }

  function lineMotionAnchor(direction: "up" | "down", count: number) {
    const textarea = input.textarea()
    const cursor = textarea.cursorOffset
    const start = lineStartOffset(textarea.plainText, cursor)
    repeatCount(count, () => (direction === "down" ? moveLineDown(textarea, 0) : moveLineUp(textarea, 0)))
    const anchor = textarea.cursorOffset
    textarea.cursorOffset = cursor
    return lineStartOffset(textarea.plainText, anchor) === start ? null : anchor
  }

  function yankLineMotion(direction: "up" | "down", count: number) {
    const textarea = input.textarea()
    const anchor = lineMotionAnchor(direction, count)
    if (anchor === null) return { span: null, register: null }
    const cursorLine = lineStartOffset(textarea.plainText, textarea.cursorOffset)
    const anchorLine = lineStartOffset(textarea.plainText, anchor)
    const span = {
      start: Math.min(cursorLine, anchorLine),
      end: lineEndOffset(textarea.plainText, Math.max(cursorLine, anchorLine)),
    }
    return { span, register: { text: textarea.plainText.slice(span.start, span.end), linewise: true } }
  }

  function clearPendingOperatorDisplay() {
    if (pendingOperatorDisplay) pendingOperatorCount = 1
    pendingOperatorDisplay = undefined
  }

  function displayLinewiseOperation(span: VimSpan | null): VimOperatorResult {
    if (!span) return { span: null, register: null }
    const text = input.textarea().plainText.slice(span.start, span.end)
    return { span, register: { text: text.endsWith("\n") ? text.slice(0, -1) : text, linewise: true } }
  }

  function visualLineHorizontalMotionOperator(key: string, operation: VimOperator): boolean {
    const count = takeOperatorCount()
    const result = () => {
      const textarea = input.textarea()
      const cursor = textarea.cursorOffset
      moveDisplayHorizontal(key, key === "$" ? count : 1)
      const target = textarea.cursorOffset
      textarea.cursorOffset = cursor

      if (key === "$") {
        const end = textarea.plainText[target] && textarea.plainText[target] !== "\n" ? target + 1 : target
        return charwiseOperation(end > cursor ? { start: cursor, end } : null)
      }

      if (target === cursor) return charwiseOperation(null)

      const span = { start: Math.min(cursor, target), end: Math.max(cursor, target) }
      return charwiseOperation(span.end > span.start ? span : null)
    }

    if (operation === "y") {
      const yanked = result()
      applyOperatorYank(yanked)
      if (yanked.span) input.textarea().cursorOffset = yanked.span.start
      return true
    }

    applyOperatorResult(result, operation)
    return true
  }

  function visualLineMotionOperator(key: string, operation: VimOperator): boolean {
    const direction = key === "j" || key === "down" ? "down" : key === "k" || key === "up" ? "up" : undefined
    if (!direction) return false

    const count = takeOperatorCount()
    const result = () => {
      const textarea = input.textarea()
      const cursor = textarea.cursorOffset
      const view = textarea.editorView as { getVisualCursor?: () => { visualCol: number } }
      moveDisplayVertical(direction, count, view.getVisualCursor?.().visualCol)
      const target = textarea.cursorOffset
      textarea.cursorOffset = cursor

      if (target === cursor) return charwiseOperation(null)

      const start = Math.min(cursor, target)
      const end = Math.max(cursor, target)
      const sameColumnAtLineStart =
        lineStartOffset(textarea.plainText, cursor) === cursor && lineStartOffset(textarea.plainText, target) === target
      return sameColumnAtLineStart ? displayLinewiseOperation({ start, end }) : charwiseOperation({ start, end })
    }

    if (operation === "y") {
      const yanked = result()
      applyOperatorYank(yanked)
      if (yanked.span) input.textarea().cursorOffset = yanked.span.start
      return true
    }

    if (operation === "c") {
      const initial = result()
      if (!initial.span && !initial.register) {
        input.state.clearPending()
        return true
      }
      if (!initial.register?.linewise || !initial.span) {
        applyOperatorEdit(result, operation)
        return true
      }

      begin(() => {
        const next = result()
        if (!next.span && !next.register) {
          input.state.clearPending()
          return false
        }
        if (!next.span) {
          if (next.register) setRegister(next.register)
          input.state.clearPending()
          input.state.setMode("insert")
          return true
        }
        const end = input.textarea().plainText[next.span.end - 1] === "\n" ? next.span.end - 1 : next.span.end
        if (end > next.span.start) deleteSpan(input.textarea(), { start: next.span.start, end })
        if (next.register) setRegister(next.register)
        input.state.clearPending()
        input.state.setMode("insert")
        return true
      })
      return true
    }

    applyOperatorResult(result, operation)
    return true
  }

  function verticalMotionOperator(event: VimEvent, key: string, operation: VimOperator): boolean {
    const direction = key === "j" || key === "down" ? "down" : key === "k" || key === "up" ? "up" : undefined
    if (!direction || event.shift || hasModifier(event)) return false
    if (displayVerticalLineMotions()) return visualLineMotionOperator(key, operation)

    const count = takeOperatorCount()
    if (operation === "y") {
      const result = yankLineMotion(direction, count)
      if (result.register) setRegister(result.register, true)
      if (result.span && result.span.end > result.span.start) input.flash?.(result.span)
      input.state.clearPending()
      return true
    }

    if (operation === "d") {
      edit(() => {
        const anchor = lineMotionAnchor(direction, count)
        const reg = anchor === null ? null : deleteLine(input.textarea(), anchor)
        input.state.clearPending()
        if (!reg) return false
        setRegister(reg)
        return true
      })
      return true
    }

    begin(() => {
      const anchor = lineMotionAnchor(direction, count)
      const reg = anchor === null ? null : substituteLine(input.textarea(), anchor)
      input.state.clearPending()
      if (!reg) return false
      setRegister(reg)
      input.state.setMode("insert")
      return true
    })
    return true
  }

  function changeWordOperation(big: boolean, count = 1) {
    const textarea = input.textarea()
    const char = textarea.plainText[textarea.cursorOffset]
    return char && !/\s/.test(char) ? wordEndOperation(big, count) : nextWordOperation(big, count)
  }

  function wordOperator(event: VimEvent, key: string, operation: VimOperator): boolean {
    if ((key === "w" || isShifted(event, "w")) && !hasModifier(event)) {
      const big = isShifted(event, "w")
      const count = takeOperatorCount()
      applyOperatorResult(
        () => (operation === "c" ? changeWordOperation(big, count) : nextWordOperation(big, count)),
        operation,
      )
      return true
    }
    if (key === "b" && !event.shift && !hasModifier(event) && operation !== "y") {
      const count = takeOperatorCount()
      applyOperatorResult(() => previousWordOperation(count), operation)
      return true
    }
    if ((key === "e" || isShifted(event, "e")) && !hasModifier(event)) {
      const count = takeOperatorCount()
      applyOperatorResult(() => wordEndOperation(isShifted(event, "e"), count), operation)
      return true
    }
    return false
  }

  function lineEndCountOperation(count: number) {
    const textarea = input.textarea()
    const start = textarea.cursorOffset
    const end = lineEndOffset(textarea.plainText, lineStartForCount(textarea.plainText, start, count))
    return charwiseOperation(end > start ? { start, end } : null)
  }

  function lineBoundaryMotion(event: VimEvent, key: string, operation: VimOperator): boolean {
    if (displayLineBoundaryMotions()) {
      if (key === "$" && !hasModifier(event)) return visualLineHorizontalMotionOperator(key, operation)
      if (key === "0" && !event.shift && !hasModifier(event)) return visualLineHorizontalMotionOperator(key, operation)
      if (key === "^" && !hasModifier(event)) return visualLineHorizontalMotionOperator(key, operation)
    }
    if (key === "$" && !hasModifier(event)) {
      const count = takeOperatorCount()
      applyOperatorResult(() => lineEndCountOperation(count), operation)
      return true
    }
    if (key === "0" && !event.shift && !hasModifier(event)) {
      pendingOperatorCount = 1
      applyOperatorResult(() => lineBeginningOperation(input.textarea()), operation)
      return true
    }
    if (key === "^" && !hasModifier(event)) {
      pendingOperatorCount = 1
      applyOperatorResult(() => firstNonWhitespaceOperation(input.textarea()), operation)
      return true
    }
    return false
  }

  function findCharTargetOffset(char: string, forward: boolean, till: boolean, count: number, repeat = false) {
    const textarea = input.textarea()
    const start = textarea.cursorOffset
    const lineStart = textarea.plainText.lastIndexOf("\n", start - 1) + 1
    const lineEnd = textarea.plainText.indexOf("\n", start)
    const line = textarea.plainText.slice(lineStart, lineEnd === -1 ? textarea.plainText.length : lineEnd)
    const target = Array.from({ length: count }).reduce<number | null>((offset, _, index) => {
      if (offset === null) return null
      return findCharTargetInLine(line, offset, char, forward, till && repeat && index === 0 ? 2 : 1)
    }, start - lineStart)
    return target === null ? null : lineStart + target
  }

  function findCharCount(char: string, forward: boolean, till: boolean, count: number, repeat = false) {
    const target = findCharTargetOffset(char, forward, till, count, repeat)
    if (target !== null) input.textarea().cursorOffset = target + (till ? (forward ? -1 : 1) : 0)
  }

  function findOperation(char: string, forward: boolean, till: boolean, count = 1) {
    const textarea = input.textarea()
    const start = textarea.cursorOffset
    const offset = findCharTargetOffset(char, forward, till, count)
    if (offset === null) return charwiseOperation(null)

    if (forward) {
      const spanEnd = till ? offset : offset + 1
      return charwiseOperation(spanEnd > start ? { start, end: spanEnd } : null)
    }

    const spanStart = till ? offset + 1 : offset
    return charwiseOperation(spanStart < start ? { start: spanStart, end: start } : null)
  }

  function startOperatorFind(event: VimEvent, operation: VimOperator, find: VimFindOperator) {
    pendingOperatorFind = { operation, find }
    input.state.setPending(find, (input.state.pendingDisplay() || operation) + find)
    event.preventDefault()
    return true
  }

  function operatorFind(event: VimEvent, key: string, operation: VimOperator) {
    if (key === "f" && !event.shift && !hasModifier(event)) return startOperatorFind(event, operation, "f")
    if (isShifted(event, "f") && !hasModifier(event)) return startOperatorFind(event, operation, "F")
    if (key === "t" && !event.shift && !hasModifier(event)) return startOperatorFind(event, operation, "t")
    if (isShifted(event, "t") && !hasModifier(event)) return startOperatorFind(event, operation, "T")
    return false
  }

  function startTextObject(event: VimEvent, operation: VimOperator, scope: VimTextObjectScope) {
    const display = (input.state.pendingDisplay() || operation) + (scope === "around" ? "a" : "i")
    takeOperatorCount()
    pendingTextObject = { operation, scope }
    input.state.setPending(operation, display)
    event.preventDefault()
    return true
  }

  function operatorTextObject(event: VimEvent, key: string, operation: VimOperator) {
    if (key === "i" && !event.shift && !hasModifier(event)) return startTextObject(event, operation, "inner")
    if (key === "a" && !event.shift && !hasModifier(event)) return startTextObject(event, operation, "around")
    return false
  }

  function resolveTextObject(event: VimEvent, key: string, scope: VimTextObjectScope, operation: VimOperator) {
    if ((key === "w" || isShifted(event, "w")) && !hasModifier(event)) {
      const big = isShifted(event, "w")
      return () => wordTextObjectOperation(input.textarea(), scope === "around", big)
    }
    if ((key === '"' || key === "'" || key === "`") && !hasModifier(event)) {
      return () => quoteTextObjectOperation(input.textarea(), scope === "around", key)
    }
    if ("()[]{}<>".includes(key) && !hasModifier(event)) {
      return () => bracketTextObjectOperation(input.textarea(), scope === "around", key, operation)
    }
  }

  function pendingTextObjectOperator(event: VimEvent, key: string): boolean {
    if (!pendingTextObject) return false
    if (input.state.pending() !== pendingTextObject.operation) {
      pendingTextObject = undefined
      return false
    }

    const textObject = pendingTextObject
    const operation = resolveTextObject(event, key, textObject.scope, textObject.operation)
    pendingTextObject = undefined
    if (operation) {
      pendingOperatorCount = 1
      applyOperatorResult(operation, textObject.operation)
      event.preventDefault()
      return true
    }

    pendingOperatorCount = 1
    input.state.clearPending()
    event.preventDefault()
    return true
  }

  function pendingFindOperator(event: VimEvent): boolean {
    if (!pendingOperatorFind) return false
    if (input.state.pending() !== pendingOperatorFind.find) {
      pendingOperatorFind = undefined
      pendingOperatorCount = 1
      return false
    }
    if (isPrintable(event) && !hasModifier(event)) {
      const forward = pendingOperatorFind.find === "f" || pendingOperatorFind.find === "t"
      const till = pendingOperatorFind.find === "t" || pendingOperatorFind.find === "T"
      const char = value(event)
      const operation = pendingOperatorFind.operation
      const count = takeOperatorCount()
      pendingOperatorFind = undefined
      applyOperatorResult(() => findOperation(char, forward, till, count), operation)
      input.state.setLastFind({ char, forward, till })
      event.preventDefault()
      return true
    }
    pendingOperatorFind = undefined
    pendingOperatorCount = 1
    input.state.clearPending()
    event.preventDefault()
    return true
  }

  function undo() {
    if (!tracked()) return false
    const next = input.state.undo(snapshot())
    if (!next) return false
    restore(next)
    return true
  }

  function redo() {
    if (!tracked()) return false
    const next = input.state.redo(snapshot())
    if (!next) return false
    restore(next)
    return true
  }

  function dispatch(event: VimEvent, key: string): boolean {
    const hadPending = !!input.state.pending()
    const hadCount = !!input.state.count()
    if (!preservesWantedColumn(event, key)) clearWantedColumn()
    if (!preservesVisualWantedColumn(event, key)) clearVisualWantedColumn()

    if (input.state.pending() === "r") {
      if (hasModifier(event)) {
        input.state.clearPending()
        return false
      }

      const next = replaceValue(event)
      if (next !== null) {
        edit(() => {
          const offset = input.textarea().cursorOffset
          if (deleteUnderCursor(input.textarea())) {
            input.textarea().cursorOffset = offset
            input.textarea().insertText(next)
            input.textarea().cursorOffset = next === "\n" ? offset + 1 : offset
            input.state.clearPending()
            return true
          }
          input.state.clearPending()
        })
        event.preventDefault()
        return true
      }

      input.state.clearPending()
      event.preventDefault()
      return true
    }

    if (pendingFindOperator(event)) return true
    if (pendingTextObjectOperator(event, key)) return true

    if (input.state.pending() === "vr" && input.state.isVisual()) {
      if (hasModifier(event)) {
        input.state.clearPending()
        return false
      }

      const next = replaceValue(event, true)
      if (next !== null) {
        edit(() => {
          replaceSelection(input.textarea(), next, input.state.isVisualLine(), input.state.anchor() ?? undefined)
          clearSelection(input.textarea())
          input.state.clearPending()
          input.state.setMode("normal")
        })
        event.preventDefault()
        return true
      }

      input.state.clearPending()
      event.preventDefault()
      return true
    }

    const find = input.state.pending()
    if (find === "f" || find === "F" || find === "t" || find === "T") {
      if (isPrintable(event) && !hasModifier(event)) {
        const forward = find === "f" || find === "t"
        const till = find === "t" || find === "T"
        const char = value(event)
        findCharCount(char, forward, till, takeCount())
        input.state.setLastFind({ char, forward, till })
        input.state.clearPending()
        event.preventDefault()
        return true
      }
      input.state.clearPending()
      event.preventDefault()
      return true
    }

    const scroll = vimScroll(event)
    if (scroll) {
      clearPendingOperatorDisplay()
      input.state.clearPending()
      input.scroll(scroll)
      event.preventDefault()
      return true
    }

    const pendingForDisplay = input.state.pending()
    if (
      (pendingForDisplay === "c" || pendingForDisplay === "d" || pendingForDisplay === "y") &&
      key === "g" &&
      !event.shift &&
      !hasModifier(event)
    ) {
      pendingOperatorDisplay = pendingForDisplay
      input.state.setPending("g", (input.state.pendingDisplay() || pendingForDisplay) + "g")
      event.preventDefault()
      return true
    }

    // Must run before vimJump, which clears pending g on non-g keys.
    if (input.state.pending() === "g" && !hasModifier(event)) {
      const operation = pendingOperatorDisplay
      if ((key === "j" || key === "k" || key === "down" || key === "up") && !event.shift) {
        pendingOperatorDisplay = undefined
        if (operation) {
          visualLineMotionOperator(key, operation)
        } else {
          const direction = key === "j" || key === "down" ? "down" : "up"
          const count = takeCount()
          prepareDisplayWantedColumn()
          input.state.clearPending()
          moveDisplayVertical(direction, count, visualWantedColumn)
        }
        event.preventDefault()
        return true
      }
      if ((key === "0" && !event.shift) || key === "^" || key === "$") {
        pendingOperatorDisplay = undefined
        if (operation) {
          visualLineHorizontalMotionOperator(key, operation)
        } else {
          const count = takeCount()
          input.state.clearPending()
          clearWantedColumn()
          moveDisplayHorizontal(key, count)
          if (key === "$") visualWantedColumn = "end"
        }
        event.preventDefault()
        return true
      }
    }

    if (input.state.pending() === "g") clearPendingOperatorDisplay()

    const jump = vimJump(event, input.state)
    if (jump.handled) {
      if (jump.action) {
        input.state.clearPending()
        clearWantedColumn()
        clearVisualWantedColumn()
        input.jump(jump.action)
      }
      event.preventDefault()
      return true
    }

    const navigation = vimWindowNavigation(event, input.state)
    if (navigation.handled) {
      if (navigation.action) {
        input.state.clearPending()
        input.navigate?.(navigation.action)
      }
      event.preventDefault()
      return true
    }

    if (key === "escape") {
      if (!input.state.pending() && input.state.count()) {
        input.state.clearCount()
        event.preventDefault()
        return true
      }
      if (input.state.isVisual()) {
        clearSelection(input.textarea())
        input.state.setMode("normal")
        event.preventDefault()
        return true
      }
      if (!input.state.pending()) return false
      input.state.clearPending()
      event.preventDefault()
      return true
    }

    if (isCountInput(event, key)) {
      input.state.appendCountDigit(key)
      event.preventDefault()
      return true
    }

    if (key === "." && !event.shift && !hasModifier(event) && !input.state.isVisual() && !input.state.pending()) {
      const repeat = input.state.repeat()
      if (repeat) repeat.run()
      event.preventDefault()
      return true
    }

    if (key === "u" && !event.shift && !hasModifier(event) && !input.state.isVisual() && !input.state.pending()) {
      undo()
      event.preventDefault()
      return true
    }

    if (
      key === "r" &&
      !!event.ctrl &&
      !event.shift &&
      !event.meta &&
      !event.super &&
      !input.state.isVisual() &&
      !input.state.pending()
    ) {
      redo()
      event.preventDefault()
      return true
    }

    if (input.state.isVisual()) {
      const a = input.state.anchor()
      const lw = input.state.isVisualLine()

      if (key === "~" && !hasModifier(event)) {
        edit(() => {
          toggleSelectionCase(input.textarea(), lw, a ?? undefined)
          clearSelection(input.textarea())
          input.state.setMode("normal")
        })
        event.preventDefault()
        return true
      }

      if (key === "r" && !event.shift && !hasModifier(event)) {
        input.state.setPending("vr")
        event.preventDefault()
        return true
      }

      if ((key === "i" || key === "a") && !event.shift && !hasModifier(event)) {
        event.preventDefault()
        return true
      }

      if (key === "o" && !event.shift && !hasModifier(event)) {
        const cursor = input.textarea().cursorOffset
        const anchor = input.state.anchor()

        if (anchor !== null) {
          input.textarea().cursorOffset = anchor
          input.state.setAnchor(cursor)
          toggleVisualEnd(input.textarea(), cursor, input.state.isVisualLine())
        }
        event.preventDefault()
        return true
      }

      if ((isShifted(event, "i") || isShifted(event, "a") || isShifted(event, "o")) && !hasModifier(event)) {
        event.preventDefault()
        return true
      }

      if ((key === "d" || key === "x") && !event.shift && !hasModifier(event)) {
        edit(() => {
          const reg = deleteSelection(input.textarea(), lw, a ?? undefined)
          if (reg) setRegister(reg)
          clearSelection(input.textarea())
          input.state.setMode("normal")
        })
        event.preventDefault()
        return true
      }

      if (isShifted(event, "d") && !hasModifier(event)) {
        edit(() => {
          const reg = deleteLine(input.textarea(), a ?? undefined)
          if (reg) setRegister(reg)
          clearSelection(input.textarea())
          input.state.setMode("normal")
        })
        event.preventDefault()
        return true
      }

      if (key === "y" && !event.shift && !hasModifier(event)) {
        const reg = yankSelection(input.textarea(), lw, a ?? undefined)
        if (reg) setRegister(reg, true)
        clearSelection(input.textarea())
        input.state.setMode("normal")
        event.preventDefault()
        return true
      }

      if (key === "c" && !event.shift && !hasModifier(event)) {
        begin(() => {
          const reg = deleteSelection(input.textarea(), lw, a ?? undefined)
          if (reg) setRegister(reg)
          clearSelection(input.textarea())
          input.state.setMode("insert")
        })
        event.preventDefault()
        return true
      }

      if (isShifted(event, "c") && !hasModifier(event)) {
        begin(() => {
          const reg = substituteLine(input.textarea(), a ?? undefined)
          if (reg) setRegister(reg)
          clearSelection(input.textarea())
          input.state.setMode("insert")
        })
        event.preventDefault()
        return true
      }

      if (key === "p" && !event.shift && !hasModifier(event)) {
        edit(() => {
          const deleted = pasteOverVisualSelection(input.textarea(), register(), lw, a ?? undefined)
          if (deleted) setRegister(deleted)
          clearSelection(input.textarea())
          input.state.setMode("normal")
        })
        event.preventDefault()
        return true
      }

      if (key === "v" && !event.shift && !hasModifier(event)) {
        if (lw) {
          input.state.setMode("visual")
          event.preventDefault()
          return true
        }
        clearSelection(input.textarea())
        input.state.setMode("normal")
        event.preventDefault()
        return true
      }

      if (isShifted(event, "v") && !hasModifier(event)) {
        if (lw) {
          clearSelection(input.textarea())
          input.state.setMode("normal")
          event.preventDefault()
          return true
        }
        input.state.setMode("visual-line")
        event.preventDefault()
        return true
      }
    }

    if (key === ":" && !hasModifier(event) && !hadPending && !hadCount) {
      input.commandPalette?.()
      input.state.clearPending()
      event.preventDefault()
      return true
    }

    // Handles a key while a c/d/y operator is pending. Returns true/false when
    // the key resolved the operator, or undefined to fall through to normal dispatch.
    function operatorPending(op: "c" | "d" | "y", event: VimEvent, key: string): boolean | undefined {
      if (hasModifier(event)) {
        pendingOperatorCount = 1
        input.state.clearPending()
        return false
      }

      if (isPendingOperatorCountInput(event, key)) {
        const count = input.state.count()
        input.state.appendCountDigit(key)
        if (input.state.count() !== count) input.state.setPending(op, (input.state.pendingDisplay() || op) + key)
        event.preventDefault()
        return true
      }

      if (key === op && !event.shift) {
        doubledOperator(op)
        event.preventDefault()
        return true
      }

      if (verticalMotionOperator(event, key, op)) {
        event.preventDefault()
        return true
      }

      if (wordOperator(event, key, op)) {
        event.preventDefault()
        return true
      }

      if (lineBoundaryMotion(event, key, op)) {
        event.preventDefault()
        return true
      }

      if (operatorTextObject(event, key, op)) return true

      if (paragraphOperator(key, op)) {
        event.preventDefault()
        return true
      }

      if (matchingBracketOperator(key, op)) {
        event.preventDefault()
        return true
      }

      if (operatorFind(event, key, op)) return true

      pendingOperatorCount = 1
      pendingTextObject = undefined
      input.state.clearPending()
      return undefined
    }

    // cc / dd / yy operate on whole lines.
    function doubledOperator(op: "c" | "d" | "y") {
      if (op === "c") {
        const count = takeOperatorCount()
        begin(() => {
          const reg = substituteLineCount(count)
          if (reg) setRegister(reg)
          input.state.clearPending()
          input.state.setMode("insert")
        })
        return
      }
      if (op === "d") {
        const count = takeOperatorCount()
        edit(() => {
          const reg = deleteLineCount(count)
          if (reg) setRegister(reg)
          input.state.clearPending()
        })
        return
      }
      const result = yankLineCount(takeOperatorCount())
      setRegister(result.register, true)
      if (result.span.end > result.span.start) input.flash?.(result.span)
      input.state.clearPending()
    }

    if ((key === "/" || key === "?") && !hasModifier(event) && !hadPending && !hadCount && !input.state.isVisual()) {
      if (input.copySearchStart?.(key === "?" ? "backward" : "forward") !== false) {
        input.state.clearPending()
        event.preventDefault()
        return true
      }
    }

    const pendingOperator = input.state.pending()
    if (pendingOperator === "c" || pendingOperator === "d" || pendingOperator === "y") {
      const handled = operatorPending(pendingOperator, event, key)
      if (handled !== undefined) return handled
    }

    if (key === "return" && !hasModifier(event)) {
      input.submit()
      input.state.clearPending()
      event.preventDefault()
      return true
    }

    if ((key === "/" || key === "@") && !hasModifier(event)) {
      if (input.autocomplete && input.textarea().cursorOffset === 0 && input.textarea().plainText.length === 0) {
        input.state.setMode("insert")
        input.textarea().insertText(key)
        event.preventDefault()
        return true
      }
      event.preventDefault()
      return true
    }

    if (key === "c" && !event.shift && !hasModifier(event)) return startOperator(event, "c")

    if (key === "d" && !event.shift && !hasModifier(event)) return startOperator(event, "d")

    if (key === "y" && !event.shift && !hasModifier(event)) return startOperator(event, "y")

    if (key === "r" && !event.shift && !hasModifier(event)) {
      input.state.setPending("r")
      event.preventDefault()
      return true
    }

    if (key === "p" && !event.shift && !hasModifier(event)) {
      const reg = register()
      edit(() => {
        const deleted = input.pasteOverSelection?.() !== false ? pasteOverSelection(input.textarea(), reg) : null
        if (deleted) setRegister(deleted)
        else pasteAfter(input.textarea(), reg)
      })
      event.preventDefault()
      return true
    }

    if (isShifted(event, "p") && !hasModifier(event)) {
      const reg = register()
      edit(() => {
        const deleted = input.pasteOverSelection?.() !== false ? pasteOverSelection(input.textarea(), reg) : null
        if (deleted) setRegister(deleted)
        else pasteBefore(input.textarea(), reg)
      })
      event.preventDefault()
      return true
    }

    if ((key === "f" || key === "t") && !event.shift && !hasModifier(event)) {
      input.state.setPending(key, input.state.count() + key)
      event.preventDefault()
      return true
    }

    if ((isShifted(event, "f") || isShifted(event, "t")) && !hasModifier(event)) {
      const find = isShifted(event, "f") ? "F" : "T"
      input.state.setPending(find, input.state.count() + find)
      event.preventDefault()
      return true
    }

    if (key === ";" && !event.shift && !hasModifier(event)) {
      const last = input.state.lastFind()
      if (last) findCharCount(last.char, last.forward, last.till, takeCount(), true)
      event.preventDefault()
      return true
    }

    if (key === "," && !event.shift && !hasModifier(event)) {
      const last = input.state.lastFind()
      if (last) findCharCount(last.char, !last.forward, last.till, takeCount(), true)
      event.preventDefault()
      return true
    }

    if (isShifted(event, "s") && !hasModifier(event)) {
      begin(() => {
        input.state.clearPending()
        const reg = substituteLine(input.textarea())
        if (reg) setRegister(reg)
        input.state.setMode("insert")
      })
      event.preventDefault()
      return true
    }

    if (isShifted(event, "d") && !hasModifier(event)) {
      edit(() => {
        const reg = deleteLineEnd(input.textarea())
        if (reg) setRegister(reg)
      })
      event.preventDefault()
      return true
    }

    if (isShifted(event, "c") && !hasModifier(event)) {
      begin(() => {
        const reg = substituteLineEnd(input.textarea())
        if (reg) setRegister(reg)
        input.state.setMode("insert")
      })
      event.preventDefault()
      return true
    }

    if (isShifted(event, "r") && !hasModifier(event)) {
      begin(
        () => {
          input.state.setReplace(input.textarea().cursorOffset)
          input.state.setTyped(false)
          input.state.setMode("replace")
        },
        { replace: true },
      )
      event.preventDefault()
      return true
    }

    if (key === "v" && !event.shift && !hasModifier(event)) {
      input.state.setAnchor(input.textarea().cursorOffset)
      input.state.setMode("visual")
      syncSelection(input.textarea(), input.textarea().cursorOffset)
      event.preventDefault()
      return true
    }

    if (isShifted(event, "v") && !hasModifier(event)) {
      input.state.setAnchor(input.textarea().cursorOffset)
      input.state.setMode("visual-line")
      syncSelection(input.textarea(), input.textarea().cursorOffset, true)
      event.preventDefault()
      return true
    }

    if (key === "i" && !event.shift && !hasModifier(event)) {
      begin(() => {
        input.state.setMode("insert")
      })
      event.preventDefault()
      return true
    }

    if (isShifted(event, "i") && !hasModifier(event)) {
      begin(() => {
        insertLineStart(input.textarea())
        input.state.setMode("insert")
      })
      event.preventDefault()
      return true
    }

    if (key === "a" && !event.shift && !hasModifier(event)) {
      begin(() => {
        appendAfterCursor(input.textarea())
        input.state.setMode("insert")
      })
      event.preventDefault()
      return true
    }

    if (isShifted(event, "a") && !hasModifier(event)) {
      begin(() => {
        appendLineEnd(input.textarea())
        input.state.setMode("insert")
      })
      event.preventDefault()
      return true
    }

    if (key === "o" && !event.shift && !hasModifier(event)) {
      begin(() => {
        openLineBelow(input.textarea())
        input.state.setMode("insert")
      })
      event.preventDefault()
      return true
    }

    if (isShifted(event, "o") && !hasModifier(event)) {
      begin(() => {
        openLineAbove(input.textarea())
        input.state.setMode("insert")
      })
      event.preventDefault()
      return true
    }

    if (key === "h" && !event.shift && !hasModifier(event)) {
      countedMotion(() => moveLeft(input.textarea()))
      event.preventDefault()
      return true
    }

    if (key === "l" && !event.shift && !hasModifier(event)) {
      countedMotion(() => moveRight(input.textarea()))
      event.preventDefault()
      return true
    }

    if (isShifted(event, "j") && !hasModifier(event)) {
      edit(() => {
        input.state.clearPending()
        joinLines(input.textarea())
      })
      event.preventDefault()
      return true
    }

    if ((key === "j" || key === "down") && !event.shift && !hasModifier(event)) {
      if (displayVerticalLineMotions()) {
        const count = takeCount()
        prepareDisplayWantedColumn()
        moveDisplayVertical("down", count, visualWantedColumn)
      } else {
        countedMotion(() => moveVertical("down"))
      }
      event.preventDefault()
      return true
    }

    if (isShifted(event, "h") && !hasModifier(event)) {
      input.jump("high")
      event.preventDefault()
      return true
    }

    if (isShifted(event, "m") && !hasModifier(event)) {
      input.jump("middle")
      event.preventDefault()
      return true
    }

    if (isShifted(event, "l") && !hasModifier(event)) {
      input.jump("low")
      event.preventDefault()
      return true
    }

    if ((key === "k" || key === "up") && !event.shift && !hasModifier(event)) {
      if (displayVerticalLineMotions()) {
        const count = takeCount()
        prepareDisplayWantedColumn()
        moveDisplayVertical("up", count, visualWantedColumn)
      } else {
        countedMotion(() => moveVertical("up"))
      }
      event.preventDefault()
      return true
    }

    if (key === "0" && !event.shift && !hasModifier(event)) {
      if (displayLineBoundaryMotions()) moveDisplayHorizontal("0", 1)
      else moveLineBeginning(input.textarea())
      event.preventDefault()
      return true
    }

    if ((key === "^" || key === "_") && !hasModifier(event)) {
      if (displayLineBoundaryMotions() && key === "^") moveDisplayHorizontal("^", 1)
      else moveFirstNonWhitespace(input.textarea())
      event.preventDefault()
      return true
    }

    if (key === "$" && !hasModifier(event)) {
      if (displayLineBoundaryMotions()) {
        moveDisplayHorizontal("$", takeCount())
        visualWantedColumn = "end"
      } else {
        repeatCount(takeCount() - 1, () => moveLineDown(input.textarea(), 0))
        moveLineEnd(input.textarea())
        wantedColumn = "end"
      }
      event.preventDefault()
      return true
    }

    if (key === "%" && !hasModifier(event)) {
      moveMatchingBracket(input.textarea())
      event.preventDefault()
      return true
    }

    if (key === "{" && !hasModifier(event)) {
      countedMotion(() => movePreviousParagraph(input.textarea()))
      event.preventDefault()
      return true
    }

    if (key === "}" && !hasModifier(event)) {
      countedMotion(() => moveNextParagraph(input.textarea()))
      event.preventDefault()
      return true
    }

    if (key === "s" && !event.shift && !hasModifier(event)) {
      begin(() => {
        const cursor = input.textarea().cursorOffset
        const reg = deleteUnderCursor(input.textarea())
        if (reg) {
          setRegister(reg)
          input.textarea().cursorOffset = cursor
        }
        input.state.setMode("insert")
      })
      event.preventDefault()
      return true
    }

    if (key === "x" && !event.shift && !hasModifier(event)) {
      edit(() => {
        const reg = deleteUnderCursor(input.textarea())
        if (reg) setRegister(reg)
      })
      event.preventDefault()
      return true
    }

    if (key === "~" && !hasModifier(event)) {
      edit(() => {
        toggleCase(input.textarea())
      })
      event.preventDefault()
      return true
    }

    if (key === "w" && !event.shift && !hasModifier(event)) {
      countedMotion(() => moveWordNext(input.textarea()))
      event.preventDefault()
      return true
    }

    if (key === "b" && !event.shift && !hasModifier(event)) {
      countedMotion(() => moveWordPrev(input.textarea()))
      event.preventDefault()
      return true
    }

    if (key === "e" && !event.shift && !hasModifier(event)) {
      countedMotion(() => moveWordEnd(input.textarea()))
      event.preventDefault()
      return true
    }

    if (isShifted(event, "w") && !hasModifier(event)) {
      countedMotion(() => moveBigWordNext(input.textarea()))
      event.preventDefault()
      return true
    }

    if (isShifted(event, "b") && !hasModifier(event)) {
      countedMotion(() => moveBigWordPrev(input.textarea()))
      event.preventDefault()
      return true
    }

    if (isShifted(event, "e") && !hasModifier(event)) {
      countedMotion(() => moveBigWordEnd(input.textarea()))
      event.preventDefault()
      return true
    }

    if (key === "w" && event.ctrl && !event.shift && !event.meta && !event.super) {
      input.state.setPending("w", "^W")
      event.preventDefault()
      return true
    }

    if (key === "backspace" || key === "delete") {
      event.preventDefault()
      return true
    }

    if (isPrintable(event) && !hasModifier(event)) {
      event.preventDefault()
      return true
    }

    return false
  }

  function copyMotion(offset: number) {
    input.setCopyCol?.(offset)
  }

  function copy(event: VimEvent, key: string): boolean {
    if (input.copySearchActive?.()) {
      if (key === "return") {
        input.copySearchSubmit?.()
        event.preventDefault()
        return true
      }
      if (key === "escape") {
        input.copySearchCancel?.()
        event.preventDefault()
        return true
      }
      if (key === "backspace" || key === "delete" || (key === "h" && event.ctrl && !event.meta && !event.super)) {
        input.copySearchBackspace?.()
        event.preventDefault()
        return true
      }
      if (!hasModifier(event) && isPrintable(event)) {
        input.copySearchAppend?.(value(event))
        event.preventDefault()
        return true
      }
      event.preventDefault()
      return true
    }

    if (input.state.pending() === "" && isShifted(event, "y") && !hasModifier(event)) {
      if (input.copyIsVisual?.()) {
        input.copyYank?.()
        input.state.setMode("normal")
        input.copyExit?.()
        event.preventDefault()
        return true
      }
      input.copyYankLine?.()
      setTimeout(() => {
        input.state.setMode("normal")
        input.copyExit?.()
      }, 70)
      event.preventDefault()
      return true
    }

    if (key === "y" && !event.shift && !hasModifier(event)) {
      if (input.copyIsVisual?.()) {
        input.copyYank?.()
        input.copyExitPreserveScroll?.()
        input.state.setMode("normal")
        event.preventDefault()
        return true
      }
      if (input.state.pending() === "y") {
        input.state.clearPending()
        input.copyYankLine?.()
        setTimeout(() => {
          input.copyExitPreserveScroll?.()
          input.state.setMode("normal")
        }, 70)
        event.preventDefault()
        return true
      }
      input.state.setPending("y")
      event.preventDefault()
      return true
    }

    const pending = input.state.pending()
    const clearCopyPending = () => {
      if (input.state.pending()) input.state.clearPending()
    }
    if (pending === "y") {
      input.state.clearPending()
    }

    if (key === "return") {
      if (!event.shift && !input.copyIsVisual?.() && (input.copyToggleCollapsed?.() || input.copyActivate?.())) {
        event.preventDefault()
        return true
      }
      input.copyCopy?.()
      if (event.shift) {
        input.state.setMode("normal")
        input.copyExit?.()
        event.preventDefault()
        return true
      }
      input.copyExitPreserveScroll?.()
      input.state.setMode("normal")
      event.preventDefault()
      return true
    }
    if (key === "v" && event.ctrl && !event.shift && !event.meta && !event.super) {
      clearCopyPending()
      input.copyVisual?.("block")
      event.preventDefault()
      return true
    }
    if (key === "q") {
      input.state.setMode("normal")
      input.copyExit?.()
      event.preventDefault()
      return true
    }
    if (pending === "" && key === "i" && !event.shift && !hasModifier(event)) {
      begin()
      input.copyFocusInput?.()
      input.state.setMode("insert")
      event.preventDefault()
      return true
    }

    if (key === "escape") {
      if (input.copyIsVisual?.()) {
        input.copyExitVisual?.()
        event.preventDefault()
        return true
      }
      if (input.copySearchHighlighted?.() && input.copySearchClear?.()) {
        event.preventDefault()
        return true
      }
      input.state.setMode("normal")
      input.copyExit?.()
      event.preventDefault()
      return true
    }

    if (input.state.pending() === "w") {
      if (key === "j" || key === "w") {
        if (input.copyIsVisual?.()) {
          input.copyExitVisual?.()
          event.preventDefault()
          return true
        }
        input.state.setSkipExitOnModeChange(true)
        input.state.setExitScrollToBottom(false)
        input.state.setMode("normal")
        input.copyExit?.(false)
        event.preventDefault()
        return true
      }
      input.state.clearPending()
    }

    if (key === "w" && event.ctrl && !event.shift && !event.meta && !event.super) {
      input.state.setPending("w", "^W")
      event.preventDefault()
      return true
    }

    const scroll = vimScroll(event)
    if (scroll) {
      clearCopyPending()
      if (scroll === "half-down" && input.copyHalfPage) input.copyHalfPage("down")
      else if (scroll === "half-up" && input.copyHalfPage) input.copyHalfPage("up")
      else input.scroll(scroll)
      event.preventDefault()
      return true
    }

    const jump = vimJump(event, input.state)
    if (jump.handled) {
      if (jump.action) input.copyJump ? input.copyJump(jump.action) : input.jump(jump.action)
      event.preventDefault()
      return true
    }

    if (hasModifier(event)) {
      clearCopyPending()
      return false
    }

    if (pending === "" && key === "/") {
      clearCopyPending()
      input.copySearchStart?.("forward")
      event.preventDefault()
      return true
    }

    if (pending === "" && key === "?") {
      clearCopyPending()
      input.copySearchStart?.("backward")
      event.preventDefault()
      return true
    }

    if (pending === "" && key === "n" && !event.shift) {
      clearCopyPending()
      input.copySearchNext?.()
      event.preventDefault()
      return true
    }

    if (pending === "" && isShifted(event, "n")) {
      clearCopyPending()
      input.copySearchPrevious?.()
      event.preventDefault()
      return true
    }

    if (isShifted(event, "h")) {
      clearCopyPending()
      input.copyJump?.("high")
      event.preventDefault()
      return true
    }

    if (isShifted(event, "m")) {
      clearCopyPending()
      input.copyJump?.("middle")
      event.preventDefault()
      return true
    }

    if (isShifted(event, "l")) {
      clearCopyPending()
      input.copyJump?.("low")
      event.preventDefault()
      return true
    }

    if (isShifted(event, "v")) {
      clearCopyPending()
      input.copyVisual?.("line")
      event.preventDefault()
      return true
    }

    if (key === "v" && !event.shift) {
      clearCopyPending()
      input.copyVisual?.("char")
      event.preventDefault()
      return true
    }

    if (key === "o" && !hasModifier(event) && input.copyIsVisual?.() && !isShifted(event, "o")) {
      input.copyToggleVisualEnd?.()
      event.preventDefault()
      return true
    }

    if (pending === "f" || pending === "F" || pending === "t" || pending === "T") {
      if (key.length === 1) {
        const forward = pending === "f" || pending === "t"
        const till = pending === "t" || pending === "T"
        const text = input.copyText?.() ?? ""
        const pos = input.copyCol?.() ?? 0
        const col = findCharInLine(text, pos, key, forward, till)
        input.state.setLastFind({ char: key, forward, till })
        input.state.clearPending()
        copyMotion(col)
        event.preventDefault()
        return true
      }
      input.state.clearPending()
      event.preventDefault()
      return true
    }

    if (pending === "z") {
      input.state.clearPending()
      if (key === "z") input.copyScroll?.("center")
      else if (key === "t") input.copyScroll?.("top")
      else if (key === "b") input.copyScroll?.("bottom")
      event.preventDefault()
      return true
    }

    if (key === "j" || key === "down") {
      input.copy?.("down")
      event.preventDefault()
      return true
    }

    if (key === "k" || key === "up") {
      input.copy?.("up")
      event.preventDefault()
      return true
    }

    if (key === "h" || key === "left") {
      input.copy?.("left")
      event.preventDefault()
      return true
    }

    if (key === "l" || key === "right") {
      input.copy?.("right")
      event.preventDefault()
      return true
    }

    const pos = input.copyCol?.() ?? 0

    // line motions
    if (key === "0") {
      copyMotion(0)
      input.setCopyStick?.("start")
      event.preventDefault()
      return true
    }

    if (key === "^" || key === "_") {
      const text = input.copyText?.() ?? ""
      copyMotion(firstNonWhitespace(text, 0))
      input.setCopyStick?.("first")
      event.preventDefault()
      return true
    }

    if (key === "$") {
      const text = input.copyText?.() ?? ""
      copyMotion(Math.max(0, text.length - 1))
      input.setCopyStick?.("end")
      event.preventDefault()
      return true
    }

    if (key === "%") {
      if (pending === "y") {
        input.state.clearPending()
        if (input.copyYankMatchingBracket?.()) {
          setTimeout(() => {
            input.copyExitPreserveScroll?.()
            input.state.setMode("normal")
          }, 70)
        }
        event.preventDefault()
        return true
      }
      if (!input.copyMatchingBracket?.()) {
        const text = input.copyText?.() ?? ""
        const target = matchingBracketTarget(text, pos)
        if (target !== null) copyMotion(target)
      }
      event.preventDefault()
      return true
    }

    if (key === "z" && !event.shift) {
      input.state.setPending("z")
      event.preventDefault()
      return true
    }

    // word motions
    if (key === "w" && !event.shift) {
      if (input.copyWordNext?.(false)) {
        event.preventDefault()
        return true
      }
      const text = input.copyText?.() ?? ""
      const col = nextWordStart(text, pos, false)
      copyMotion(Math.min(col, Math.max(0, text.length - 1)))
      event.preventDefault()
      return true
    }

    if (key === "b" && !event.shift) {
      if (input.copyWordPrev?.(false)) {
        event.preventDefault()
        return true
      }
      const text = input.copyText?.() ?? ""
      copyMotion(prevWordStart(text, pos, false))
      event.preventDefault()
      return true
    }

    if (key === "e" && !event.shift) {
      if (input.copyWordEnd?.(false)) {
        event.preventDefault()
        return true
      }
      const text = input.copyText?.() ?? ""
      copyMotion(wordEnd(text, pos, false))
      event.preventDefault()
      return true
    }

    if (isShifted(event, "w")) {
      if (input.copyWordNext?.(true)) {
        event.preventDefault()
        return true
      }
      const text = input.copyText?.() ?? ""
      const col = nextWordStart(text, pos, true)
      copyMotion(Math.min(col, Math.max(0, text.length - 1)))
      event.preventDefault()
      return true
    }

    if (isShifted(event, "b")) {
      if (input.copyWordPrev?.(true)) {
        event.preventDefault()
        return true
      }
      const text = input.copyText?.() ?? ""
      copyMotion(prevWordStart(text, pos, true))
      event.preventDefault()
      return true
    }

    if (isShifted(event, "e")) {
      if (input.copyWordEnd?.(true)) {
        event.preventDefault()
        return true
      }
      const text = input.copyText?.() ?? ""
      copyMotion(wordEnd(text, pos, true))
      event.preventDefault()
      return true
    }

    // paragraph motions
    if (key === "{" && !hasModifier(event)) {
      input.copyPreviousParagraph?.()
      event.preventDefault()
      return true
    }

    if (key === "}" && !hasModifier(event)) {
      input.copyNextParagraph?.()
      event.preventDefault()
      return true
    }

    // find-char pending
    if ((key === "f" || key === "t") && !event.shift) {
      input.state.setPending(key, key)
      event.preventDefault()
      return true
    }

    if (isShifted(event, "f")) {
      input.state.setPending("F", "F")
      event.preventDefault()
      return true
    }

    if (isShifted(event, "t")) {
      input.state.setPending("T", "T")
      event.preventDefault()
      return true
    }

    // repeat find
    if (key === ";") {
      const last = input.state.lastFind()
      if (last) {
        const text = input.copyText?.() ?? ""
        copyMotion(findCharInLine(text, pos, last.char, last.forward, last.till, true))
      }
      event.preventDefault()
      return true
    }

    if (key === ",") {
      const last = input.state.lastFind()
      if (last) {
        const text = input.copyText?.() ?? ""
        copyMotion(findCharInLine(text, pos, last.char, !last.forward, last.till, true))
      }
      event.preventDefault()
      return true
    }

    if (isPrintable(event)) {
      event.preventDefault()
      return true
    }

    return false
  }

  return {
    beginInsertEdit: repeat.begin,
    finishInsertEdit,
    handleKey(event: VimEvent) {
      if (!input.enabled()) return false

      // Keep dot replay atomic
      if (input.state.replaying()) {
        event.preventDefault()
        return true
      }

      if (input.state.isReplace()) {
        if (event.name === "escape") {
          const start = input.state.replace()
          const typed = input.state.typed()
          input.state.setMode("normal")
          if (typed && start !== null) {
            input.textarea().cursorOffset = Math.max(start, input.textarea().cursorOffset - 1)
          }
          input.state.commitEdit(snapshot())
          repeat.commit(snapshot())
          event.preventDefault()
          return true
        }

        if (isPrintable(event) && !hasModifier(event)) {
          const next = value(event)
          repeat.recordReplaceChar(next)
          replaceUnderCursor(input.textarea(), next)
          input.state.setTyped(true)
          event.preventDefault()
          return true
        }

        return false
      }

      if (input.state.isCopy()) {
        clearEscapePending()
        const mapped = input.copySearchActive?.() ? event : langmapped(event)
        return copy(mapped, normalizedKeyName(mapped))
      }

      if (input.state.isInsert()) {
        // Escape always takes priority over pending escape sequence
        if (event.name === "escape") {
          clearEscapePending()
          input.state.setMode("normal")
          input.state.commitEdit(snapshot())
          moveLeft(input.textarea())
          repeat.commit(snapshot())
          event.preventDefault()
          return true
        }

        // Two-key escape sequence support (e.g., "jk" to exit insert mode)
        if (escapeSeq) {
          const key = normalizedKeyName(event)
          if (escapePending) {
            clearEscapePending()
            if (key === escapeSecond && !hasModifier(event)) {
              // Remove the first char that was already typed using proper textarea API
              const pos = input.textarea().cursorOffset
              if (pos > 0) {
                const start = input.textarea().editBuffer.offsetToPosition(pos - 1)
                const end = input.textarea().editBuffer.offsetToPosition(pos)
                if (start && end) {
                  input.textarea().deleteRange(start.row, start.col, end.row, end.col)
                  input.textarea().cursorOffset = pos - 1
                }
              }
              // Trigger escape
              input.state.setMode("normal")
              input.state.commitEdit(snapshot())
              moveLeft(input.textarea())
              repeat.commit(snapshot())
              event.preventDefault()
              return true
            }
            // Not the escape sequence; first char already typed, let current key through
            return false
          }
          if (key === escapeFirst && !hasModifier(event)) {
            escapePending = true
            escapeTimer = setTimeout(clearEscapePending, 300)
            return false // Let first char type normally
          }
        }

        clearEscapePending()
        return false
      }

      clearEscapePending()

      const mapped = langmapped(event)
      const key = normalizedKeyName(mapped)
      const result = dispatch(mapped, key)

      if (result && input.state.count() && !input.state.pending() && !isCountInput(mapped, key))
        input.state.clearCount()

      if (result && input.state.isVisual()) {
        const a = input.state.anchor()
        if (a !== null) syncSelection(input.textarea(), a, input.state.isVisualLine())
      }

      return result
    },
  }
}
