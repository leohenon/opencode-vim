import type { TextareaRenderable } from "@opentui/core"
import type { VimRegister } from "./vim-state"

export type VimSpan = { start: number; end: number }
export type VimCopyRow = { col: number }
export type VimWantedColumn = number | "end"

const bracketPairs = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
])
const bracketClosers = new Map(Array.from(bracketPairs, ([open, close]) => [close, open]))

export function lineStart(text: string, offset: number) {
  if (offset <= 0) return 0
  const index = text.lastIndexOf("\n", offset - 1)
  if (index === -1) return 0
  return index + 1
}

export function lineEnd(text: string, offset: number) {
  const index = text.indexOf("\n", offset)
  if (index === -1) return text.length
  return index
}

function lineLast(text: string, offset: number) {
  const start = lineStart(text, offset)
  const end = lineEnd(text, offset)
  if (end > start) return end - 1
  return start
}

function prevLineStart(text: string, offset: number) {
  const start = lineStart(text, offset)
  if (start === 0) return undefined
  return lineStart(text, start - 1)
}

function nextLineStart(text: string, offset: number) {
  const end = lineEnd(text, offset)
  if (end >= text.length) return undefined
  return end + 1
}

function isBlankLine(text: string, lineStartOffset: number) {
  return lineEnd(text, lineStartOffset) === lineStartOffset
}

// vim treats a trailing \n as EOL of the last line, not a new empty line.
// Differs from nextLineStart on "abc\n": this returns null, that returns 4.
function paragraphAdvance(text: string, lineOffset: number): number | null {
  const end = lineEnd(text, lineOffset)
  if (end >= text.length - 1) return null
  return end + 1
}

function paragraphRetreat(text: string, lineOffset: number): number | null {
  if (lineOffset <= 0) return null
  return lineStart(text, lineOffset - 1)
}

function nextParagraphTarget(text: string, cursor: number): number {
  if (text.length === 0) return 0
  let probe = lineStart(text, cursor)
  while (isBlankLine(text, probe)) {
    const next = paragraphAdvance(text, probe)
    if (next === null) return probe
    probe = next
  }
  while (!isBlankLine(text, probe)) {
    const next = paragraphAdvance(text, probe)
    if (next === null) return lineLast(text, text.length - 1)
    probe = next
  }
  return probe
}

function previousParagraphTarget(text: string, cursor: number): number {
  if (text.length === 0 || cursor === 0) return 0
  let probe = lineStart(text, cursor)
  while (isBlankLine(text, probe)) {
    const previous = paragraphRetreat(text, probe)
    if (previous === null) return 0
    probe = previous
  }
  while (probe > 0) {
    const previous = paragraphRetreat(text, probe)
    if (previous === null) return 0
    if (isBlankLine(text, previous)) return previous
    probe = previous
  }
  return 0
}

function lineColumn(text: string, offset: number) {
  return offset - lineStart(text, offset)
}

function bracketAtOrAfter(text: string, offset: number) {
  const end = lineEnd(text, offset)
  for (let pos = offset; pos < end; pos++) {
    if (bracketPairs.has(text[pos]!) || bracketClosers.has(text[pos]!)) return pos
  }
  return null
}

function matchingForward(text: string, offset: number, open: string, close: string) {
  let depth = 1
  for (let pos = offset + 1; pos < text.length; pos++) {
    if (text[pos] === open) depth++
    if (text[pos] === close) depth--
    if (depth === 0) return pos
  }
  return null
}

function matchingBackward(text: string, offset: number, open: string, close: string) {
  let depth = 1
  for (let pos = offset - 1; pos >= 0; pos--) {
    if (text[pos] === close) depth++
    if (text[pos] === open) depth--
    if (depth === 0) return pos
  }
  return null
}

export function matchingBracketTarget(text: string, offset: number) {
  if (!text.length) return null
  const source = bracketAtOrAfter(text, Math.max(0, Math.min(offset, text.length - 1)))
  if (source === null) return null
  const char = text[source]!
  const close = bracketPairs.get(char)
  if (close) return matchingForward(text, source, char, close)
  const open = bracketClosers.get(char)
  if (open) return matchingBackward(text, source, open, char)
  return null
}

function moveUp(text: string, offset: number, column: VimWantedColumn = lineColumn(text, offset)) {
  const targetStart = prevLineStart(text, offset)
  if (targetStart === undefined) return offset
  const targetLast = lineLast(text, targetStart)
  const col = column === "end" ? targetLast - targetStart : column
  return Math.min(targetStart + col, targetLast)
}

function moveDown(text: string, offset: number, column: VimWantedColumn = lineColumn(text, offset)) {
  const targetStart = nextLineStart(text, offset)
  if (targetStart === undefined) return offset
  const targetLast = lineLast(text, targetStart)
  const col = column === "end" ? targetLast - targetStart : column
  return Math.min(targetStart + col, targetLast)
}

export function getLineColumn(textarea: TextareaRenderable) {
  return lineColumn(textarea.plainText, textarea.cursorOffset)
}

export function moveLeft(textarea: TextareaRenderable) {
  const text = textarea.plainText
  const start = lineStart(text, textarea.cursorOffset)
  textarea.cursorOffset = Math.max(start, textarea.cursorOffset - 1)
}

export function moveLineBeginning(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = lineStart(text, textarea.cursorOffset)
}

export function moveFirstNonWhitespace(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = firstNonWhitespace(text, textarea.cursorOffset)
}

export function moveLineEnd(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = lineLast(text, textarea.cursorOffset)
}

export function clampCursorToLine(textarea: TextareaRenderable) {
  const text = textarea.plainText
  const last = lineLast(text, textarea.cursorOffset)
  if (textarea.cursorOffset > last) textarea.cursorOffset = last
}

export function alignVisualColumn(textarea: TextareaRenderable, column: number) {
  const view = textarea.editorView as {
    getVisualCursor?: () => { visualRow: number; visualCol: number; offset: number }
    setCursorByOffset?: (offset: number) => void
  }
  if (typeof view?.getVisualCursor !== "function") return

  let cursor = view.getVisualCursor()
  const row = cursor.visualRow
  const text = textarea.plainText

  while (cursor.visualCol < column) {
    const next = textarea.cursorOffset + 1
    if (next > lineLast(text, textarea.cursorOffset)) break

    if (typeof view.setCursorByOffset === "function") view.setCursorByOffset(next)
    else textarea.cursorOffset = next

    const moved = view.getVisualCursor()
    if (moved.offset === cursor.offset || moved.visualRow !== row) {
      textarea.cursorOffset = cursor.offset
      break
    }
    cursor = moved
  }
}

export function moveRight(textarea: TextareaRenderable) {
  const text = textarea.plainText
  const last = lineLast(text, textarea.cursorOffset)
  textarea.cursorOffset = Math.min(last, textarea.cursorOffset + 1)
}

export function moveLineUp(textarea: TextareaRenderable, column?: VimWantedColumn) {
  const text = textarea.plainText
  textarea.cursorOffset = moveUp(text, textarea.cursorOffset, column)
}

export function moveLineDown(textarea: TextareaRenderable, column?: VimWantedColumn) {
  const text = textarea.plainText
  textarea.cursorOffset = moveDown(text, textarea.cursorOffset, column)
}

// Use TextareaRenderable's public APIs so wrapping matches OpenTUI.
export function moveVisualLineUp(textarea: TextareaRenderable) {
  if (typeof textarea.moveCursorUp === "function") {
    textarea.moveCursorUp()
    return
  }
  moveLineUp(textarea)
}

export function moveVisualLineDown(textarea: TextareaRenderable) {
  if (typeof textarea.moveCursorDown === "function") {
    textarea.moveCursorDown()
    return
  }
  moveLineDown(textarea)
}

function setVisualOffset(textarea: TextareaRenderable, offset: number) {
  const view = textarea.editorView as { setCursorByOffset?: (offset: number) => void }
  if (typeof view?.setCursorByOffset === "function") view.setCursorByOffset(offset)
  else textarea.cursorOffset = offset
}

function visualRow(textarea: TextareaRenderable) {
  const view = textarea.editorView as { getVisualCursor?: () => { visualRow: number } }
  return typeof view?.getVisualCursor === "function" ? view.getVisualCursor().visualRow : undefined
}

function visualLineStartFallback(textarea: TextareaRenderable, row: number) {
  let offset = textarea.cursorOffset
  while (offset > lineStart(textarea.plainText, offset)) {
    setVisualOffset(textarea, offset - 1)
    const moved = textarea.cursorOffset
    if (moved === offset) return offset
    if (visualRow(textarea) !== row) {
      setVisualOffset(textarea, offset)
      return offset
    }
    offset = moved
  }
  return offset
}

function visualLineEndFallback(textarea: TextareaRenderable, row: number) {
  let offset = textarea.cursorOffset
  while (offset < lineLast(textarea.plainText, offset)) {
    setVisualOffset(textarea, offset + 1)
    const moved = textarea.cursorOffset
    if (moved === offset) return offset
    if (visualRow(textarea) !== row) {
      setVisualOffset(textarea, offset)
      return offset
    }
    offset = moved
  }
  return offset
}

export function visualLineStart(textarea: TextareaRenderable) {
  const cursor = textarea.cursorOffset
  const row = visualRow(textarea)
  if (row === undefined) return lineStart(textarea.plainText, cursor)
  if (typeof textarea.gotoVisualLineHome !== "function") return visualLineStartFallback(textarea, row)
  textarea.gotoVisualLineHome()
  const start = textarea.cursorOffset
  setVisualOffset(textarea, cursor)
  return start
}

export function visualLineEnd(textarea: TextareaRenderable) {
  const cursor = textarea.cursorOffset
  const row = visualRow(textarea)
  if (row === undefined) return lineLast(textarea.plainText, cursor)
  if (typeof textarea.gotoVisualLineEnd !== "function") return visualLineEndFallback(textarea, row)
  const start = visualLineStart(textarea)
  textarea.gotoVisualLineEnd()
  const raw = textarea.cursorOffset
  const exclusive = raw >= textarea.plainText.length || textarea.plainText[raw] === "\n"
  const end = Math.max(start, exclusive ? raw - 1 : raw)
  setVisualOffset(textarea, cursor)
  return end
}

export function moveVisualLineBeginning(textarea: TextareaRenderable) {
  if (typeof textarea.gotoVisualLineHome === "function") {
    textarea.gotoVisualLineHome()
    return
  }
  setVisualOffset(textarea, visualLineStart(textarea))
}

export function moveVisualFirstNonWhitespace(textarea: TextareaRenderable) {
  const start = visualLineStart(textarea)
  const end = visualLineEnd(textarea)
  for (let offset = start; offset <= end; offset++) {
    const char = textarea.plainText[offset]
    if (char && !/\s/.test(char)) {
      setVisualOffset(textarea, offset)
      return
    }
  }
  setVisualOffset(textarea, start)
}

export function moveVisualLineEnd(textarea: TextareaRenderable) {
  setVisualOffset(textarea, visualLineEnd(textarea))
}

export function moveMatchingBracket(textarea: TextareaRenderable) {
  const target = matchingBracketTarget(textarea.plainText, textarea.cursorOffset)
  if (target === null) return false
  textarea.cursorOffset = target
  return true
}

export function movePreviousParagraph(textarea: TextareaRenderable) {
  textarea.cursorOffset = previousParagraphTarget(textarea.plainText, textarea.cursorOffset)
}

export function moveNextParagraph(textarea: TextareaRenderable) {
  textarea.cursorOffset = nextParagraphTarget(textarea.plainText, textarea.cursorOffset)
}

export type VimOperator = "d" | "c" | "y"

export type VimOperatorResult = {
  span: VimSpan | null
  register: VimRegister
}

export function matchingBracketOperation(textarea: TextareaRenderable): VimOperatorResult {
  const text = textarea.plainText
  const cursor = textarea.cursorOffset
  const target = matchingBracketTarget(text, cursor)
  if (target === null) return { span: null, register: null }
  const span = target < cursor ? { start: target, end: cursor + 1 } : { start: cursor, end: target + 1 }
  return { span, register: { text: text.slice(span.start, span.end), linewise: false } }
}

// vim linewise register convention: content ends with \n per line terminator.
function asLinewise(slice: string): string {
  return slice.endsWith("\n") ? slice : slice + "\n"
}

function buildOperatorResult(
  text: string,
  span: VimSpan | null,
  registerSpan: VimSpan | null,
  linewise: boolean,
): VimOperatorResult {
  if (!span) return { span: null, register: null }
  const register = registerSpan ?? span
  const slice = text.slice(register.start, register.end)
  return { span, register: { text: linewise ? asLinewise(slice) : slice, linewise } }
}

export function lineBeginningOperation(textarea: TextareaRenderable): VimOperatorResult {
  const text = textarea.plainText
  const end = textarea.cursorOffset
  const start = lineStart(text, end)
  return buildOperatorResult(text, start < end ? { start, end } : null, null, false)
}

export function firstNonWhitespaceOperation(textarea: TextareaRenderable): VimOperatorResult {
  const text = textarea.plainText
  const cursor = textarea.cursorOffset
  const target = firstNonWhitespace(text, cursor)
  if (target === cursor) return { span: null, register: null }
  return buildOperatorResult(text, { start: Math.min(target, cursor), end: Math.max(target, cursor) }, null, false)
}

type NextClassification = {
  lineStartOffset: number
  onBlank: boolean
  lineAligned: boolean
  target: number
  targetIsBlank: boolean
  multiLine: boolean
}

function classifyNextParagraph(text: string, cursor: number): NextClassification {
  const lineStartOffset = lineStart(text, cursor)
  const onBlank = isBlankLine(text, lineStartOffset)
  const target = nextParagraphTarget(text, cursor)
  const targetLineStart = lineStart(text, target)
  return {
    lineStartOffset,
    onBlank,
    lineAligned: onBlank || cursor === lineStartOffset,
    target,
    targetIsBlank: target === targetLineStart && target < text.length && isBlankLine(text, target),
    multiLine: lineStartOffset !== targetLineStart,
  }
}

// linewise rules derived empirically from nvim:
//   d: line-aligned cursor + (blank target OR motion crosses lines)
//   y/c: line-aligned cursor AND blank target
function isLinewiseNext(c: NextClassification, op: VimOperator): boolean {
  if (!c.lineAligned) return false
  return op === "d" ? c.targetIsBlank || c.multiLine : c.targetIsBlank
}

// d at EOF with no trailing \n extends the delete span back to swallow the
// preceding \n separator, but keeps the register range tight.
// c strips the trailing \n that d/y keep (preserves line structure).
function nextLinewiseSpan(
  text: string,
  c: NextClassification,
  op: VimOperator,
): { span: VimSpan | null; registerSpan: VimSpan | null } {
  if (op === "d" && !c.targetIsBlank) {
    const extendBack = text[text.length - 1] !== "\n" && c.lineStartOffset > 0
    return {
      span: { start: extendBack ? c.lineStartOffset - 1 : c.lineStartOffset, end: text.length },
      registerSpan: { start: c.lineStartOffset, end: text.length },
    }
  }
  const end = op === "c" ? c.target - 1 : c.target
  if (end <= c.lineStartOffset) return { span: null, registerSpan: null }
  return { span: { start: c.lineStartOffset, end }, registerSpan: null }
}

// onBlank branch is only reached by y/c from a blank line with a non-blank
// target (d-from-blank is always linewise via the multi-line rule).
function nextCharwiseSpan(text: string, cursor: number, c: NextClassification): VimSpan | null {
  const end = c.targetIsBlank ? c.target - 1 : c.onBlank ? text.length : c.target + 1
  if (end <= cursor) return null
  return { start: cursor, end }
}

export function nextParagraphOperation(textarea: TextareaRenderable, operation: VimOperator): VimOperatorResult {
  const text = textarea.plainText
  const cursor = textarea.cursorOffset
  if (text.length === 0) return { span: null, register: null }

  const c = classifyNextParagraph(text, cursor)
  if (!isLinewiseNext(c, operation)) return buildOperatorResult(text, nextCharwiseSpan(text, cursor, c), null, false)
  const { span, registerSpan } = nextLinewiseSpan(text, c, operation)
  return buildOperatorResult(text, span, registerSpan, true)
}

// vim `{` operator. linewise for all of y/d/c when cursor is line-aligned.
// c strips the trailing \n at cursor-1; d/y keep it.
export function previousParagraphOperation(textarea: TextareaRenderable, operation: VimOperator): VimOperatorResult {
  const text = textarea.plainText
  const cursor = textarea.cursorOffset
  if (text.length === 0 || cursor === 0) return { span: null, register: null }

  const lineStartOffset = lineStart(text, cursor)
  const linewise = isBlankLine(text, lineStartOffset) || cursor === lineStartOffset
  const target = previousParagraphTarget(text, cursor)
  if (target >= cursor) return { span: null, register: null }

  if (!linewise || operation !== "c") return buildOperatorResult(text, { start: target, end: cursor }, null, linewise)
  const end = text[cursor - 1] === "\n" ? cursor - 1 : cursor
  return buildOperatorResult(text, end > target ? { start: target, end } : null, null, true)
}

function isWord(char: string) {
  return /[A-Za-z0-9_]/.test(char)
}

function isBigWord(char: string) {
  return !/\s/.test(char)
}

export function nextWordStart(text: string, offset: number, big: boolean) {
  let pos = offset
  if (pos >= text.length) return text.length

  const startClass = wordClass(text[pos], big)
  if (startClass !== "blank") {
    while (pos < text.length && wordClass(text[pos], big) === startClass) pos++
  }

  while (pos < text.length && wordClass(text[pos], big) === "blank") pos++
  return pos
}

export function prevWordStart(text: string, offset: number, big: boolean) {
  let pos = Math.min(offset, text.length)
  if (pos <= 0) return 0
  pos--

  while (pos > 0 && wordClass(text[pos], big) === "blank") pos--

  const target = wordClass(text[pos], big)
  while (pos > 0 && wordClass(text[pos - 1], big) === target) pos--

  return pos
}

function wordClass(char: string, big: boolean): "blank" | "word" | "punct" {
  if (!isBigWord(char)) return "blank"
  if (big || isWord(char)) return "word"
  return "punct"
}

function wordRunEnd(text: string, offset: number, big: boolean) {
  const target = wordClass(text[offset], big)
  let pos = offset
  while (pos + 1 < text.length && wordClass(text[pos + 1], big) === target) pos++
  return pos
}

export function wordEnd(text: string, offset: number, big: boolean) {
  if (text.length === 0) return 0
  let pos = offset
  if (pos >= text.length) pos = text.length - 1

  const startClass = wordClass(text[pos], big)
  const atRunEnd = startClass === "blank" || pos + 1 >= text.length || wordClass(text[pos + 1], big) !== startClass

  if (atRunEnd) {
    pos++
    while (pos < text.length && wordClass(text[pos], big) === "blank") pos++
    if (pos >= text.length) return text.length - 1
  }

  return wordRunEnd(text, pos, big)
}

export function wordTextObjectOperation(textarea: TextareaRenderable, around: boolean, big = false): VimOperatorResult {
  const text = textarea.plainText
  if (!text.length) return { span: null, register: null }

  const blank = wordTextObjectBlankSpan(text, textarea.cursorOffset, big)
  if (blank) {
    if (!around) return buildOperatorResult(text, blank, null, false)
    return buildOperatorResult(text, wordTextObjectAroundBlankSpan(text, blank, big), null, false)
  }

  const inner = wordTextObjectInnerSpan(text, textarea.cursorOffset, big)
  if (!inner) return { span: null, register: null }
  if (!around) return buildOperatorResult(text, inner, null, false)

  let end = inner.end
  while (end < text.length && text[end] !== "\n" && wordClass(text[end], big) === "blank") end++
  if (end > inner.end) return buildOperatorResult(text, { start: inner.start, end }, null, false)

  let start = inner.start
  while (start > 0 && text[start - 1] !== "\n" && wordClass(text[start - 1], big) === "blank") start--
  return buildOperatorResult(text, { start, end: inner.end }, null, false)
}

function wordTextObjectInnerSpan(text: string, cursor: number, big: boolean): VimSpan | null {
  const pos = Math.min(cursor, text.length - 1)
  if (text[pos] === "\n") return null
  const target = wordClass(text[pos], big)
  let start = pos
  while (start > 0 && wordClass(text[start - 1], big) === target) start--

  let end = pos + 1
  while (end < text.length && wordClass(text[end], big) === target) end++

  return start < end ? { start, end } : null
}

function wordTextObjectBlankSpan(text: string, cursor: number, big: boolean): VimSpan | null {
  let start = Math.min(cursor, text.length - 1)
  if (wordClass(text[start], big) !== "blank" || text[start] === "\n") return null
  while (start > 0 && text[start - 1] !== "\n" && wordClass(text[start - 1], big) === "blank") start--

  let end = start
  while (end < text.length && text[end] !== "\n" && wordClass(text[end], big) === "blank") end++

  return start < end ? { start, end } : null
}

function wordTextObjectAroundBlankSpan(text: string, blank: VimSpan, big: boolean): VimSpan | null {
  let end = blank.end
  while (end < text.length && text[end] !== "\n" && wordClass(text[end], big) === "blank") end++
  if (end >= text.length || text[end] === "\n") return null

  const inner = wordTextObjectInnerSpan(text, end, big)
  if (!inner) return null
  end = inner.end
  while (end < text.length && text[end] !== "\n" && wordClass(text[end], big) === "blank") end++

  return { start: blank.start, end }
}

export function bracketTextObjectOperation(
  textarea: TextareaRenderable,
  around: boolean,
  bracket: string,
  operation: VimOperator,
): VimOperatorResult {
  const text = textarea.plainText
  if (!text.length) return { span: null, register: null }

  const pair = bracketTextObjectPair(text, textarea.cursorOffset, bracket)
  if (!pair) return { span: null, register: null }

  const span = around ? { start: pair.start, end: pair.end + 1 } : bracketTextObjectInnerSpan(text, pair, operation)
  const registerSpan = around ? null : bracketTextObjectInnerSpan(text, pair, "d")
  if (span.start < span.end) return buildOperatorResult(text, span, registerSpan, false)
  return { span: { start: span.start, end: span.start }, register: { text: "", linewise: false } }
}

function bracketTextObjectInnerSpan(text: string, pair: VimSpan, operation: VimOperator) {
  const start = pair.start + 1
  const end = pair.end
  if (text[start] === "\n" && text[end - 1] === "\n")
    return { start: start + 1, end: operation === "c" ? end - 1 : end }
  return { start, end }
}

function bracketTextObjectPair(text: string, cursor: number, bracket: string): VimSpan | null {
  const pair = bracketTextObjectPairChars(bracket)
  if (!pair) return null

  const containing = bracketTextObjectContainingPair(text, cursor, 0, text.length, pair.open, pair.close)
  if (containing) return containing

  const pairStart = bracketTextObjectOpenAfterCursor(text, cursor, text.length, pair.open)
  if (pairStart === null) return null

  const pairEnd = bracketTextObjectClose(text, pairStart, text.length, pair.open, pair.close)
  return pairEnd === null ? null : { start: pairStart, end: pairEnd }
}

function bracketTextObjectPairChars(bracket: string) {
  if (bracket === "(" || bracket === ")") return { open: "(", close: ")" }
  if (bracket === "[" || bracket === "]") return { open: "[", close: "]" }
  if (bracket === "{" || bracket === "}") return { open: "{", close: "}" }
  if (bracket === "<" || bracket === ">") return { open: "<", close: ">" }
  return null
}

function bracketTextObjectContainingPair(
  text: string,
  cursor: number,
  start: number,
  end: number,
  open: string,
  close: string,
): VimSpan | null {
  const stack = []
  let result: VimSpan | null = null
  for (let index = start; index < end; index++) {
    if (text[index] === open) stack.push(index)
    if (text[index] !== close) continue

    const pairStart = stack.pop()
    if (pairStart === undefined || pairStart > cursor || index < cursor) continue
    if (!result || pairStart > result.start) result = { start: pairStart, end: index }
  }
  return result
}

function bracketTextObjectOpenAfterCursor(text: string, cursor: number, end: number, open: string) {
  const index = text.indexOf(open, cursor)
  return index === -1 || index >= end ? null : index
}

function bracketTextObjectClose(text: string, start: number, end: number, open: string, close: string) {
  let depth = 0
  for (let index = start; index < end; index++) {
    if (text[index] === open) depth++
    if (text[index] === close) {
      depth--
      if (depth === 0) return index
    }
  }
  return null
}

export function quoteTextObjectOperation(
  textarea: TextareaRenderable,
  around: boolean,
  quote: string,
): VimOperatorResult {
  const text = textarea.plainText
  if (!text.length) return { span: null, register: null }

  const pair = quoteTextObjectPair(text, textarea.cursorOffset, quote)
  if (!pair) return { span: null, register: null }

  const span = around ? quoteTextObjectAroundSpan(text, pair) : { start: pair.start + 1, end: pair.end }
  if (span.start < span.end) return buildOperatorResult(text, span, null, false)
  return { span: { start: span.start, end: span.start }, register: { text: "", linewise: false } }
}

function quoteTextObjectAroundSpan(text: string, pair: VimSpan) {
  let end = pair.end + 1
  while (end < text.length && text[end] !== "\n" && isHorizontalWhitespace(text[end])) end++
  if (end > pair.end + 1) return { start: pair.start, end }

  let start = pair.start
  while (start > 0 && text[start - 1] !== "\n" && isHorizontalWhitespace(text[start - 1])) start--
  return { start, end: pair.end + 1 }
}

function quoteTextObjectPair(text: string, cursor: number, quote: string): VimSpan | null {
  const start = lineStart(text, cursor)
  const end = lineEnd(text, cursor)
  const positions = []
  for (let position = start; position < end; position++) {
    if (text[position] === quote && !isEscaped(text, position)) positions.push(position)
  }
  if (positions.length < 2) return null

  const index = positions.findIndex((position) => position >= cursor)
  if (index === -1) return null
  if (positions[index] === cursor) {
    const pairIndex = index % 2 === 0 ? index : index - 1
    const pairEnd = positions[pairIndex + 1]
    return pairEnd === undefined ? null : { start: positions[pairIndex]!, end: pairEnd }
  }

  const previous = positions[index - 1]
  if (previous === undefined) {
    const pairEnd = positions[1]
    return pairEnd === undefined ? null : { start: positions[0]!, end: pairEnd }
  }

  return { start: previous, end: positions[index]! }
}

function isHorizontalWhitespace(char: string | undefined) {
  return char === " " || char === "\t"
}

function isEscaped(text: string, position: number) {
  let backslashes = 0
  for (let index = position - 1; index >= 0 && text[index] === "\\"; index--) backslashes++
  return backslashes % 2 === 1
}

function deleteOffsets(textarea: TextareaRenderable, startOffset: number, endOffset: number) {
  if (endOffset <= startOffset) return
  const end = Math.min(endOffset, textarea.plainText.length)
  if (end <= startOffset) return
  const start = textarea.editBuffer.offsetToPosition(startOffset)
  const pos = textarea.editBuffer.offsetToPosition(end)
  if (!start || !pos) return
  textarea.deleteRange(start.row, start.col, pos.row, pos.col)
  textarea.cursorOffset = startOffset
}

function swap(char: string) {
  const low = char.toLowerCase()
  const up = char.toUpperCase()
  if (char === low && char !== up) return up
  if (char === up && char !== low) return low
  return char
}

export function moveWordNext(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = nextWordStart(text, textarea.cursorOffset, false)
}

export function moveWordPrev(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = prevWordStart(text, textarea.cursorOffset, false)
}

export function moveWordEnd(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = wordEnd(text, textarea.cursorOffset, false)
}

export function moveBigWordNext(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = nextWordStart(text, textarea.cursorOffset, true)
}

export function moveBigWordPrev(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = prevWordStart(text, textarea.cursorOffset, true)
}

export function moveBigWordEnd(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = wordEnd(text, textarea.cursorOffset, true)
}

export function firstNonWhitespace(text: string, offset: number) {
  const start = lineStart(text, offset)
  const end = lineEnd(text, offset)
  let pos = start
  while (pos < end && /\s/.test(text[pos])) pos++
  return pos
}

export function findCharTargetInLine(text: string, offset: number, char: string, forward: boolean, skip = 1) {
  if (forward) {
    for (let i = offset + skip; i < text.length; i++) {
      if (text[i] === char) return i
    }
    return null
  }
  for (let i = offset - skip; i >= 0; i--) {
    if (text[i] === char) return i
  }
  return null
}

export function findCharInLine(
  text: string,
  offset: number,
  char: string,
  forward: boolean,
  till = false,
  repeat = false,
) {
  const target = findCharTargetInLine(text, offset, char, forward, till && repeat ? 2 : 1)
  if (target === null) return offset
  return till ? target + (forward ? -1 : 1) : target
}

export function copyWordNext(rows: VimCopyRow[], get: (idx: number) => string, idx: number, col: number, big: boolean) {
  const row = rows[idx]
  if (!row) return { idx, col }
  const min = row.col
  const text = get(idx)
  const pos = Math.max(0, col - min)
  const next = nextWordStart(text, pos, big)
  if (next < text.length) return { idx, col: min + next }
  for (let i = idx + 1; i < rows.length; i++) {
    const nextRow = rows[i]
    if (!nextRow) continue
    const nextText = get(i)
    if (!nextText.length) return { idx: i, col: nextRow.col }
    const nextCol = nextWordStart(nextText, 0, big)
    if (nextCol < nextText.length) return { idx: i, col: nextRow.col + nextCol }
    if (nextText.length > 0) return { idx: i, col: nextRow.col + nextText.length - 1 }
  }
  return { idx, col: min + Math.max(0, text.length - 1) }
}

export function copyWordPrev(rows: VimCopyRow[], get: (idx: number) => string, idx: number, col: number, big: boolean) {
  const row = rows[idx]
  if (!row) return { idx, col }
  const min = row.col
  const text = get(idx)
  const pos = Math.max(0, col - min)
  const prev = prevWordStart(text, pos, big)
  if (prev < pos) return { idx, col: min + prev }
  for (let i = idx - 1; i >= 0; i--) {
    const prevRow = rows[i]
    if (!prevRow) continue
    const prevText = get(i)
    if (!prevText.length) return { idx: i, col: prevRow.col }
    const prevCol = prevWordStart(prevText, prevText.length, big)
    return { idx: i, col: prevRow.col + prevCol }
  }
  return { idx, col: min }
}

export function copyWordEnd(rows: VimCopyRow[], get: (idx: number) => string, idx: number, col: number, big: boolean) {
  const row = rows[idx]
  if (!row) return { idx, col }
  const min = row.col
  const text = get(idx)
  const pos = Math.max(0, col - min)
  const end = wordEnd(text, pos, big)
  if (end > pos && wordClass(text[end], big) !== "blank") return { idx, col: min + end }
  for (let i = idx + 1; i < rows.length; i++) {
    const nextRow = rows[i]
    if (!nextRow) continue
    const nextText = get(i)
    const start = nextText.split("").findIndex((char) => wordClass(char, big) !== "blank")
    if (start === -1) continue
    return { idx: i, col: nextRow.col + wordRunEnd(nextText, start, big) }
  }
  return { idx, col: min + Math.max(0, text.length - 1) }
}

export function copyMatchingBracket(rows: VimCopyRow[], get: (idx: number) => string, idx: number, col: number) {
  const row = rows[idx]
  if (!row) return { idx, col }
  const texts = rows.map((_, i) => get(i))
  let start = 0
  const starts = texts.map((text) => {
    const current = start
    start += text.length + 1
    return current
  })
  const text = texts.join("\n")
  const local = Math.max(0, col - row.col)
  const target = matchingBracketTarget(text, starts[idx]! + local)
  if (target === null) return { idx, col }

  const targetIdx = starts.findLastIndex((start, i) => target >= start && target < start + texts[i]!.length)
  const targetRow = rows[targetIdx]
  if (!targetRow) return { idx, col }
  return { idx: targetIdx, col: targetRow.col + target - starts[targetIdx]! }
}

export type CopyParagraphResult = { index: number; atEnd: boolean }

// `atEnd` is true only when content runs to EOF without a trailing blank line,
// the only case where vim `}` lands on end-of-line instead of column 0.
export function copyNextParagraph(
  rows: VimCopyRow[],
  get: (index: number) => string,
  index: number,
): CopyParagraphResult {
  if (!rows.length) return { index: 0, atEnd: false }
  let cursor = index
  while (cursor < rows.length && get(cursor) === "") cursor++
  if (cursor === rows.length) return { index: rows.length - 1, atEnd: false }
  while (cursor < rows.length && get(cursor) !== "") cursor++
  if (cursor === rows.length) return { index: rows.length - 1, atEnd: true }
  return { index: cursor, atEnd: false }
}

// no `atEnd` counterpart: vim `{` always lands on column 0 of the target row.
export function copyPreviousParagraph(
  rows: VimCopyRow[],
  get: (index: number) => string,
  index: number,
): CopyParagraphResult {
  if (!rows.length) return { index: 0, atEnd: false }
  let cursor = index
  while (cursor > 0 && get(cursor) === "") cursor--
  if (get(cursor) === "") return { index: 0, atEnd: false }
  while (cursor > 0) {
    cursor--
    if (get(cursor) === "") return { index: cursor, atEnd: false }
  }
  return { index: 0, atEnd: false }
}

export function appendAfterCursor(textarea: TextareaRenderable) {
  const text = textarea.plainText
  const end = lineEnd(text, textarea.cursorOffset)
  textarea.cursorOffset = Math.min(textarea.cursorOffset + 1, end)
}

export function appendLineEnd(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = lineEnd(text, textarea.cursorOffset)
}

export function insertLineStart(textarea: TextareaRenderable) {
  const text = textarea.plainText
  textarea.cursorOffset = firstNonWhitespace(text, textarea.cursorOffset)
}

export function openLineBelow(textarea: TextareaRenderable) {
  const text = textarea.plainText
  const end = lineEnd(text, textarea.cursorOffset)
  textarea.cursorOffset = end
  textarea.insertText("\n")
}

export function openLineAbove(textarea: TextareaRenderable) {
  const text = textarea.plainText
  const start = lineStart(text, textarea.cursorOffset)
  textarea.cursorOffset = start
  textarea.insertText("\n")
  textarea.cursorOffset = start
}

export function deleteUnderCursor(textarea: TextareaRenderable): VimRegister {
  const text = textarea.plainText
  const startOffset = textarea.cursorOffset
  const end = lineEnd(text, startOffset)
  if (startOffset >= end) return null
  const yanked = text[startOffset]
  deleteOffsets(textarea, startOffset, startOffset + 1)
  clampCursorToLine(textarea)
  return { text: yanked, linewise: false }
}

export function deleteLine(textarea: TextareaRenderable, anchor?: number): VimRegister {
  const text = textarea.plainText
  if (!text.length) return null

  const offset = textarea.cursorOffset
  const lo = anchor !== undefined ? Math.min(anchor, offset) : offset
  const hi = anchor !== undefined ? Math.max(anchor, offset) : offset
  const start = lineStart(text, lo)
  const end = lineEnd(text, hi)
  const yanked = text.slice(start, end)

  if (end < text.length) {
    deleteOffsets(textarea, start, end + 1)
    return { text: yanked, linewise: true }
  }

  if (start > 0) {
    deleteOffsets(textarea, start - 1, end)
    textarea.cursorOffset = lineStart(textarea.plainText, textarea.cursorOffset)
    return { text: yanked, linewise: true }
  }

  deleteOffsets(textarea, start, end)
  return { text: yanked, linewise: true }
}

export function deleteLineEnd(textarea: TextareaRenderable): VimRegister {
  const text = textarea.plainText
  const start = textarea.cursorOffset
  const end = lineEnd(text, start)
  if (end <= start) return null
  const yanked = text.slice(start, end)
  deleteOffsets(textarea, start, end)
  textarea.cursorOffset = lineLast(textarea.plainText, start)
  return { text: yanked, linewise: false }
}

export function deleteSpan(textarea: TextareaRenderable, span: VimSpan | null): void {
  if (!span || span.end <= span.start) return
  deleteOffsets(textarea, span.start, span.end)
}

export function joinLines(textarea: TextareaRenderable) {
  const text = textarea.plainText
  const end = lineEnd(text, textarea.cursorOffset)
  if (end >= text.length) return
  let next = end + 1
  while (next < text.length && (text[next] === " " || text[next] === "\t")) next++
  const trailing = end > 0 && /[ \t]/.test(text[end - 1])
  const paren = next < text.length && text[next] === ")"
  deleteOffsets(textarea, end, next)
  if (!trailing && !paren) textarea.insertText(" ")
  textarea.cursorOffset = end
}

export function substituteLine(textarea: TextareaRenderable, anchor?: number): VimRegister {
  const text = textarea.plainText
  const offset = textarea.cursorOffset
  const lo = anchor !== undefined ? Math.min(anchor, offset) : offset
  const hi = anchor !== undefined ? Math.max(anchor, offset) : offset
  const start = lineStart(text, lo)
  const end = lineEnd(text, hi)
  if (end <= start) return null
  const yanked = text.slice(start, end)
  deleteOffsets(textarea, start, end)
  return { text: yanked, linewise: true }
}

export function substituteLineEnd(textarea: TextareaRenderable): VimRegister {
  const text = textarea.plainText
  const start = textarea.cursorOffset
  const end = lineEnd(text, start)
  if (end <= start) return null
  const yanked = text.slice(start, end)
  deleteOffsets(textarea, start, end)
  return { text: yanked, linewise: false }
}

export function replaceUnderCursor(textarea: TextareaRenderable, value: string) {
  const text = textarea.plainText
  const offset = textarea.cursorOffset
  if (offset >= text.length || text[offset] === "\n") {
    textarea.insertText(value)
    return
  }
  deleteOffsets(textarea, offset, offset + 1)
  textarea.insertText(value)
}

export function toggleCase(textarea: TextareaRenderable) {
  const text = textarea.plainText
  const start = textarea.cursorOffset
  const end = lineEnd(text, start)
  if (start >= end) return
  const char = text[start]
  const next = swap(char)
  if (next !== char) {
    deleteOffsets(textarea, start, start + 1)
    textarea.insertText(next)
    textarea.cursorOffset = start
  }
  moveRight(textarea)
}

export function pasteAfter(textarea: TextareaRenderable, reg: VimRegister) {
  if (!reg) return
  if (reg.linewise) {
    const text = textarea.plainText
    const end = lineEnd(text, textarea.cursorOffset)
    textarea.cursorOffset = end
    textarea.insertText("\n" + reg.text)
    textarea.cursorOffset = end + 1
    return
  }
  textarea.cursorOffset = Math.min(textarea.cursorOffset + 1, textarea.plainText.length)
  textarea.insertText(reg.text)
  textarea.cursorOffset = textarea.cursorOffset - 1
}

export function pasteBefore(textarea: TextareaRenderable, reg: VimRegister) {
  if (!reg) return
  if (reg.linewise) {
    const text = textarea.plainText
    const start = lineStart(text, textarea.cursorOffset)
    textarea.cursorOffset = start
    textarea.insertText(reg.text + "\n")
    textarea.cursorOffset = start
    return
  }
  textarea.insertText(reg.text)
  textarea.cursorOffset = textarea.cursorOffset - 1
}

export function pasteOverSelection(textarea: TextareaRenderable, reg: VimRegister): VimRegister {
  if (!reg) return null
  const sel = textarea.editorView.getSelection()
  if (!sel || sel.end <= sel.start) return null
  const start = Math.max(0, Math.min(sel.start, textarea.plainText.length))
  const end = Math.max(start, Math.min(sel.end, textarea.plainText.length))
  const text = textarea.plainText.slice(start, end)
  if (!text) return null
  clearSelection(textarea)
  deleteOffsets(textarea, start, end)
  textarea.insertText(reg.text)
  textarea.cursorOffset = textarea.cursorOffset - 1
  return { text, linewise: false }
}

export function pasteOverVisualSelection(
  textarea: TextareaRenderable,
  reg: VimRegister,
  linewise = false,
  anchor?: number,
): VimRegister {
  if (!reg || anchor === undefined) return null
  if (!linewise) {
    const sel = selectionRange(textarea, anchor, false)
    if (!sel) return null
    const text = textarea.plainText.slice(sel.start, sel.end)
    if (!text) return null
    clearSelection(textarea)
    deleteOffsets(textarea, sel.start, sel.end)
    textarea.insertText(reg.text)
    textarea.cursorOffset = textarea.cursorOffset - 1
    return { text, linewise: false }
  }

  const text = textarea.plainText
  const selectionStart = lineStart(text, Math.min(anchor, textarea.cursorOffset))
  const selectionEnd = lineEnd(text, Math.max(anchor, textarea.cursorOffset))
  const deleted = text.slice(selectionStart, selectionEnd)
  const prefix = selectionEnd >= text.length && selectionStart > 0 ? "\n" : ""
  const suffix = !prefix && selectionEnd < text.length ? "\n" : ""
  const start = prefix ? selectionStart - 1 : selectionStart
  const end = suffix ? selectionEnd + 1 : selectionEnd
  clearSelection(textarea)
  deleteOffsets(textarea, start, end)
  textarea.cursorOffset = start
  textarea.insertText(prefix + reg.text + suffix)
  textarea.cursorOffset = start + prefix.length
  return { text: deleted, linewise: true }
}

export function syncSelection(textarea: TextareaRenderable, anchor: number, linewise = false) {
  const text = textarea.plainText
  const cursor = textarea.cursorOffset
  let lo = Math.min(anchor, cursor)
  let hi = Math.max(anchor + 1, cursor + 1)
  if (linewise) {
    lo = lineStart(text, lo)
    hi = lineEnd(text, hi - 1)
    if (hi < text.length) hi++
  }
  const ta = textarea as any
  const forward = cursor >= anchor
  textarea.cursorOffset = forward ? lo : hi
  ta.updateSelectionForMovement(true, true)
  textarea.cursorOffset = forward ? hi : lo
  ta.updateSelectionForMovement(true, false)
  textarea.cursorOffset = cursor
  textarea.editorView.setSelection(lo, hi, textarea.selectionBg, textarea.selectionFg)
}

export function toggleVisualEnd(textarea: TextareaRenderable, anchor: number, linewise = false) {
  const text = textarea.plainText
  const cursor = textarea.cursorOffset

  let lo = Math.min(anchor, cursor)
  let hi = Math.max(anchor + 1, cursor + 1)

  if (linewise) {
    lo = lineStart(text, lo)
    hi = lineEnd(text, hi - 1)
    if (hi < text.length) hi++
  }

  textarea.editorView.setSelection(lo, hi, textarea.selectionBg, textarea.selectionFg)
}

export function clearSelection(textarea: TextareaRenderable) {
  const ta = textarea as any
  ta.updateSelectionForMovement(false, true)
  textarea.editorView.resetSelection()
}

function selectionRange(textarea: TextareaRenderable, anchor?: number, linewise = false) {
  if (anchor === undefined) return null
  let start = Math.min(anchor, textarea.cursorOffset)
  let end = Math.max(anchor + 1, textarea.cursorOffset + 1)
  if (linewise) {
    const text = textarea.plainText
    start = lineStart(text, start)
    end = lineEnd(text, end - 1)
    if (end < text.length) end++
  }
  return { start, end }
}

export function toggleSelectionCase(textarea: TextareaRenderable, linewise = false, anchor?: number) {
  const sel = selectionRange(textarea, anchor, linewise)
  if (!sel) return
  const text = textarea.plainText.slice(sel.start, sel.end)
  const next = text.split("").map(swap).join("")
  if (next !== text) {
    deleteOffsets(textarea, sel.start, sel.end)
    textarea.insertText(next)
  }
  textarea.cursorOffset = sel.start
}

export function replaceSelection(textarea: TextareaRenderable, value: string, linewise = false, anchor?: number) {
  const sel = selectionRange(textarea, anchor, linewise)
  if (!sel) return
  const next = textarea.plainText
    .slice(sel.start, sel.end)
    .split("")
    .map((char) => (char === "\n" ? char : value))
    .join("")
  deleteOffsets(textarea, sel.start, sel.end)
  textarea.insertText(next)
  textarea.cursorOffset = sel.start
}

export function deleteSelection(textarea: TextareaRenderable, linewise = false, anchor?: number): VimRegister {
  const sel = selectionRange(textarea, anchor, linewise)
  if (!sel) return null
  const text = textarea.plainText
  const yanked = text.slice(sel.start, sel.end)

  let start = sel.start
  let end = sel.end
  // ensure delete complete lines to avoid leaving empty lines
  if (linewise) {
    const hasTrailingNl = end < text.length && text[end - 1] === "\n"
    const hasLeadingNl = start > 0 && text[start - 1] === "\n"
    if (!hasTrailingNl && end < text.length && text[end] === "\n") {
      end++
    } else if (!hasTrailingNl && hasLeadingNl) {
      start--
    }
  }

  deleteOffsets(textarea, start, end)

  const after = textarea.plainText
  if (linewise) {
    if (start >= after.length && start > 0) {
      textarea.cursorOffset = lineStart(after, after.length - 1)
    } else {
      textarea.cursorOffset = lineStart(after, Math.min(start, Math.max(after.length - 1, 0)))
    }
  } else {
    textarea.cursorOffset = Math.min(start, Math.max(after.length - 1, 0))
  }
  return { text: yanked, linewise }
}

export function yankSelection(textarea: TextareaRenderable, linewise = false, anchor?: number): VimRegister {
  const sel = selectionRange(textarea, anchor, linewise)
  if (!sel) return null
  return { text: textarea.plainText.slice(sel.start, sel.end), linewise }
}
