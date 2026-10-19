import { batch, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { Part } from "@opencode-ai/sdk/v2"
import {
  copyMatchingBracket,
  copyNextParagraph,
  copyPreviousParagraph,
  copyWordEnd,
  copyWordNext,
  copyWordPrev,
  firstNonWhitespace,
} from "../../component/vim/vim-motions"
import type { CopyModeAdapter, CopySearchDirection, CopyVisualMode } from "../../component/vim/copy-adapter"
import { write as writeClipboard } from "../../clipboard"

export type CopyRow = {
  key: string
  id: string
  role: "user" | "assistant"
  kind: "user" | "text" | "reasoning" | "tool"
  part?: string
  tool?: string
  line: number
  y: number
  col: number
}

export type CopyHighlight = {
  line: number
  left: number
  right: number
  text: string
  kind?: "search"
  current?: boolean
}

type CopyState = {
  active: boolean
  idx: number
  col: number
  stick: undefined | "start" | "first" | "end" | number
  visual: undefined | CopyVisualMode
  anchor: undefined | { idx: number; col: number }
}

type CopySearchOrigin = {
  idx: number
  col: number
}

type CopySearch = {
  query: string
  direction: CopySearchDirection
  origin: CopySearchOrigin
}

type CopySearchMatch = {
  idx: number
  col: number
}

const empty: CopyState = {
  active: false,
  idx: -1,
  col: 0,
  stick: undefined,
  visual: undefined,
  anchor: undefined,
}

const segmenter = new Intl.Segmenter()
type RenderableEntry = { node: any; y: number; x: number; gutter: number; table?: TableCopy }
type CopyLineResult = { text: string; col: number; copyable?: boolean }
type TableCopy = {
  line: (localY: number) => CopyLineResult | undefined
  display: (localY: number) => CopyLineResult | undefined
}

type Endpoint = { idx: number; col: number }
function orderEndpoints(a: Endpoint, b: Endpoint): { start: Endpoint; end: Endpoint } {
  const aFirst = a.idx < b.idx || (a.idx === b.idx && a.col <= b.col)
  return aFirst ? { start: a, end: b } : { start: b, end: a }
}

export function createCopyMode(input: {
  scroll: () => ScrollBoxRenderable
  messages: Accessor<{ id: string; role: string }[]>
  parts: (id: string) => Part[]
  thinking: () => boolean
  details: () => boolean
  session: Accessor<string>
  toBottom: () => void
  toggleCollapsed?: (id: string) => boolean
  activate?: (row: CopyRow) => boolean
}) {
  const [state, setState] = createSignal<CopyState>({ ...empty })
  const [unified, setUnified] = createSignal(false)
  const [yankLineFlash, setYankLineFlash] = createSignal<number | undefined>(undefined)
  const [yankRangeFlash, setYankRangeFlash] = createSignal<{ start: Endpoint; end: Endpoint } | undefined>(undefined)
  const [activeSearch, setActiveSearch] = createSignal<CopySearch | undefined>(undefined)
  const [lastSearch, setLastSearch] = createSignal<CopySearch | undefined>(undefined)
  let yankFlashTimer: ReturnType<typeof setTimeout> | undefined
  let lastCursor: CopyRow | undefined

  function flashYankRange(start: Endpoint, end: Endpoint) {
    setYankRangeFlash(orderEndpoints(start, end))
    if (yankFlashTimer) clearTimeout(yankFlashTimer)
    yankFlashTimer = setTimeout(() => setYankRangeFlash(undefined), 70)
  }

  onCleanup(() => {
    if (yankFlashTimer) clearTimeout(yankFlashTimer)
  })

  // --- row building ---

  function rows(): CopyRow[] {
    const scroll = input.scroll()
    if (!scroll) return []

    const meta = new Map<
      string,
      {
        role: "user" | "assistant"
        kind: "user" | "text" | "reasoning" | "tool"
        part?: string
        tool?: string
      }
    >()

    for (const msg of input.messages()) {
      const parts = input.parts(msg.id)
      if (msg.role === "user") continue

      for (const part of parts) {
        const partKey = "messageID" in part && typeof part.messageID === "string" ? `${part.messageID}-${part.id}` : part.id
        if (part.type === "text") meta.set(`text-${partKey}`, { role: "assistant", kind: "text", part: part.id })
        if (part.type === "reasoning") {
          if (!input.thinking()) continue
          if (state().active) continue
          meta.set(`text-${partKey}`, { role: "assistant", kind: "reasoning", part: part.id })
        }
        if (part.type === "tool") {
          if (!input.details() && part.state.status === "completed") continue
          meta.set(`tool-${partKey}`, { role: "assistant", kind: "tool", part: part.id, tool: part.tool })
        }
      }
    }

    return scroll
      .getChildren()
      .toSorted((a, b) => a.y - b.y)
      .flatMap((child) => {
        if (!child.id) return []
        const m = meta.get(child.id)
        if (!m) return []

        const total = Math.max(1, Math.floor(child.height))
        const start = m.kind === "user" ? 1 : 0
        const end = m.kind === "user" ? Math.max(start, total - 1) : total
        return Array.from({ length: Math.max(0, end - start) }, (_, i) => ({
          key: `${m.kind}:${child.id}:${i}`,
          id: child.id,
          role: m.role,
          kind: m.kind,
          part: m.part,
          tool: m.tool,
          line: i,
          y: child.y + start + i,
          col: m.kind === "user" ? 2 : 3,
        }))
      })
  }

  // --- renderable tree helpers ---

  function findRenderables(node: any, y = 0, x = 0, gutter = 0): RenderableEntry[] {
    if (node.lineInfo && node.plainText !== undefined) return [{ node, y, x, gutter }]
    const table = tableCopy(node)
    if (table) return [{ node, y, x, gutter, table }]
    const width = gutter || ("gutter" in node && node.gutter ? node.gutter.calculateWidth() : 0)
    const result: RenderableEntry[] = []
    for (const child of node.getChildren?.() ?? []) {
      if (child._positionType === "absolute") continue
      result.push(...findRenderables(child, y + Math.floor(child._y ?? 0), x + Math.floor(child._x ?? 0), width))
    }
    return result
  }

  // TextTableRenderable does not expose rendered row/cell geometry publicly,
  // so copy mode adapts its current private layout/cell state here.
  function tableCopy(node: any): TableCopy | undefined {
    if (!node?._cells || !node?._layout || typeof node.getSelectedText !== "function") return undefined
    const rows = Array.isArray(node._cells) ? node._cells : []
    node.ensureLayoutReady?.()
    const layout = node._layout
    if (
      !Array.isArray(layout.rowOffsets) ||
      !Array.isArray(layout.rowHeights) ||
      !Array.isArray(layout.columnOffsets)
    )
      return undefined
    return {
      line(localY) {
        const rowIdx = tableRowIndex(layout, rows, localY)
        if (rowIdx < 0) return { text: "", col: 0, copyable: false }
        const cellY = tableCellY(node, layout, rowIdx, localY)
        if (cellY === undefined) return { text: "", col: 0, copyable: false }
        return {
          text: (rows[rowIdx] ?? []).map((cell: any) => cellLine(cell?.textBufferView, cellY)).join("\t"),
          col: 0,
        }
      },
      display(localY) {
        const rowIdx = tableRowIndex(layout, rows, localY)
        if (rowIdx < 0) return { text: "", col: 0, copyable: false }
        const cellY = tableCellY(node, layout, rowIdx, localY)
        if (cellY === undefined) return { text: "", col: 0, copyable: false }
        const width = tableWidth(layout)
        const chars = Array.from({ length: width }, () => " ")
        for (const [colIdx, cell] of (rows[rowIdx] ?? []).entries()) {
          const start = (layout.columnOffsets?.[colIdx] ?? 0) + 1 + Math.max(0, Math.floor(node._cellPaddingX ?? 0))
          const text = cellLine(cell?.textBufferView, cellY)
          for (const seg of segmenter.segment(text)) {
            const index = start + Bun.stringWidth(text.slice(0, seg.index))
            if (index >= 0 && index < chars.length) chars[index] = seg.segment
          }
        }
        const text = chars.join("").trimEnd()
        return text ? { text, col: 0 } : { text: "", col: 0, copyable: false }
      },
    }
  }

  function tableRowIndex(layout: any, rows: any[], localY: number): number {
    return rows.findIndex((_row: any, idx: number) => {
      const top = (layout.rowOffsets[idx] ?? 0) + 1
      const bottom = top + (layout.rowHeights[idx] ?? 1) - 1
      return localY >= top && localY <= bottom
    })
  }

  function tableCellY(node: any, layout: any, rowIdx: number, localY: number): number | undefined {
    const paddingY = Math.max(0, Math.floor(node._cellPaddingY ?? 0))
    const cellY = localY - (layout.rowOffsets[rowIdx] ?? 0) - 1 - paddingY
    const contentHeight = Math.max(1, (layout.rowHeights[rowIdx] ?? 1) - paddingY * 2)
    if (cellY < 0 || cellY >= contentHeight) return undefined
    return cellY
  }

  function tableWidth(layout: any): number {
    if (Number.isFinite(layout.tableWidth)) return Math.max(1, Math.floor(layout.tableWidth))
    const offsets = Array.isArray(layout.columnOffsets) ? layout.columnOffsets : []
    if (offsets.length) return Math.max(1, Math.floor(offsets[offsets.length - 1] ?? 0) + 1)
    return 1
  }

  function cellLine(view: any, local: number): string {
    if (!view || typeof view.getPlainText !== "function") return ""
    const lines = view.getPlainText().split("\n")
    const info = view.lineInfo
    if (info?.lineSources && local >= 0 && local < info.lineSources.length) {
      const src = info.lineSources[local]
      const source = lines[src] ?? ""
      const wrapped = info.lineSources[local - 1] === src || info.lineSources[local + 1] === src
      if (!wrapped) return source
      const lineStart = info.lineStartCols?.[local] ?? 0
      let base = lineStart
      for (let i = local - 1; i >= 0; i--) {
        if (info.lineSources[i] === src) base = info.lineStartCols?.[i] ?? base
        else break
      }
      return sliceCols(source, lineStart - base, info.lineWidthCols?.[local] ?? Bun.stringWidth(source))
    }
    return lines[local] ?? ""
  }

  function sliceCols(text: string, start: number, width: number): string {
    if (start === 0 && width >= Bun.stringWidth(text)) return text
    let col = 0
    let begin = -1
    let end = text.length
    for (const seg of segmenter.segment(text)) {
      const w = Bun.stringWidth(seg.segment)
      if (begin < 0 && col + w > start) begin = seg.index
      col += w
      if (col >= start + width) {
        end = seg.index + seg.segment.length
        break
      }
    }
    if (begin < 0) begin = 0
    return text.slice(begin, end)
  }

  function sourceLine(node: any, src: number): string | undefined {
    let current = node
    while (current) {
      const content =
        typeof current.content === "string"
          ? current.content
          : typeof current._content === "string"
            ? current._content
            : undefined
      const line = content?.split("\n")[src]
      if (line !== undefined) return line
      current = current.parent
    }
  }

  function markdownListPrefix(raw?: string): string {
    const match = raw?.match(/^(\s{0,3}(?:[-+*]|\d{1,9}[.)])\s+)(\[[ xX]\]\s+)?/)
    return match ? `${match[1] ?? ""}${match[2] ?? ""}` : ""
  }

  function stripPrefix(text: string, length: number) {
    return { text: text.slice(length), width: Bun.stringWidth(text.slice(0, length)) }
  }

  function stripMatchedPrefix(text: string, pattern: RegExp) {
    const match = text.match(pattern)
    if (!match?.[0]) return { text, width: 0 }
    return stripPrefix(text, match[0].length)
  }

  function stripRenderedListPrefix(text: string, prefix: string) {
    const task = prefix.match(/\[[ xX]\]\s+$/)?.[0]
    if (task && text.toLowerCase().startsWith(task.toLowerCase())) return stripPrefix(text, task.length)
    if (task) return stripMatchedPrefix(text, /^\[[^\]]+\]\s+/)
    return stripMatchedPrefix(text, /^(?:[-+*•◦‣]\s+|\d{1,9}[.)]\s+)/)
  }

  function prefixedText(raw: string | undefined, visiblePrefix: string, text: string) {
    const prefix = markdownListPrefix(raw)
    if (!prefix) return { text: visiblePrefix + text, colOffset: 0 }
    if (text.startsWith(prefix)) return { text, colOffset: 0 }
    const stripped = stripRenderedListPrefix(text, prefix)
    return {
      text: prefix + stripped.text,
      colOffset: -Math.max(0, Bun.stringWidth(prefix) - stripped.width),
    }
  }

  function copyResult(raw: string | undefined, visiblePrefix: string, text: string, col: number) {
    const result = prefixedText(raw, visiblePrefix, text)
    return { text: result.text, col: Math.max(0, col + result.colOffset) }
  }

  function childById(id: string, cache?: Map<string, any>) {
    if (cache) return cache.get(id)
    return input
      .scroll()
      .getChildren()
      .find((c) => c.id === id)
  }

  function entryLine(entry: { node: any; y: number }, rowLine: number): string {
    if (typeof entry.node.plainText !== "string") return ""
    const local = rowLine - entry.y
    const lines = entry.node.plainText.split("\n")
    const info = entry.node.lineInfo
    if (info?.lineSources && local >= 0 && local < info.lineSources.length) {
      return lines[info.lineSources[local]] ?? ""
    }
    return lines[local] ?? ""
  }

  function isWrappedContinuation(row: CopyRow, cache?: Map<string, any>): boolean {
    const child = childById(row.id, cache)
    if (!child) return false
    const entries = findRenderables(child)
    if (!entries.length) return false
    const match = matchingEntry(entries, row)
    if (match.table) return false
    if (typeof match.node.plainText !== "string") return false
    const local = row.line - match.y
    const info = match.node.lineInfo
    if (!info?.lineSources) return false
    const src = info.lineSources[local]
    if (src === undefined) return false
    return info.lineSources[local - 1] === src
  }

  function rowPrefix(entries: RenderableEntry[], match: RenderableEntry, row: CopyRow): string {
    const before = entries
      .filter((entry) => entry !== match && entry.y === row.line && entry.x < match.x)
      .toSorted((a, b) => a.x - b.x)
    const base = Math.min(row.col, before[0]?.x ?? match.x, match.x)
    const result = before.reduce(
      (acc, entry) => {
        const gap = Math.max(0, entry.x - base - acc.width)
        const text = entryLine(entry, row.line)
        return {
          text: acc.text + " ".repeat(gap) + text,
          width: entry.x - base + Bun.stringWidth(text),
        }
      },
      { text: "", width: 0 },
    )
    if (!before.length) return ""
    return result.text + " ".repeat(Math.max(0, match.x - base - result.width))
  }

  function matchingEntry(entries: RenderableEntry[], row: CopyRow): RenderableEntry {
    let match = entries[0]
    for (const entry of entries) {
      if (entry.y > row.line) break
      match = entry
    }
    return match
  }

  function taskSpinnerOffset(row: CopyRow, prefix: string, text: string) {
    if (prefix || row.kind !== "tool" || row.tool !== "task") return { text, col: 0 }
    const leading = text.length - text.trimStart().length
    const trimmed = text.slice(leading)
    if (!trimmed.includes(" Task — ")) return { text, col: 0 }
    if (/^[✓│~]/.test(trimmed)) return { text, col: 0 }
    const marker = trimmed.match(/^[⋯⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/)?.[0]
    if (marker) return { text: text.slice(0, leading) + trimmed.slice(marker.length), col: Bun.stringWidth(marker) }
    // Spinner renderables are not text renderables, so copy mode reserves their
    // visual width without making the transient frame part of copyable text.
    return { text, col: 2 }
  }

  function taskCopyResult(row: CopyRow, raw: string | undefined, prefix: string, text: string, col: number) {
    const offset = taskSpinnerOffset(row, prefix, text)
    return copyResult(raw, prefix, offset.text, col + offset.col)
  }

  function copyLine(row: CopyRow, child: any): CopyLineResult {
    const entries = findRenderables(child)
    if (!entries.length) return { text: "", col: 0 }
    const match = matchingEntry(entries, row)
    if (match.table) {
      const line = match.table.line(row.line - match.y)
      return line ? { ...line, col: match.gutter + line.col } : { text: "", col: match.gutter, copyable: false }
    }
    if (typeof match.node.plainText !== "string") return { text: "", col: 0 }
    const local = row.line - match.y
    let prefix = rowPrefix(entries, match, row)
    const lines = match.node.plainText.split("\n")
    const info = match.node.lineInfo
    if (info?.lineSources && local < info.lineSources.length) {
      const src = info.lineSources[local]
      const source = lines[src] ?? ""
      const wrapped =
        info.lineSources[local - 1] === src || info.lineSources[local + 1] === src
      if (!wrapped) return taskCopyResult(row, sourceLine(match.node, src), prefix, source, match.gutter)
      const lineStart = info.lineStartCols?.[local] ?? 0
      let base = lineStart
      for (let i = local - 1; i >= 0; i--) {
        if (info.lineSources[i] === src) base = info.lineStartCols?.[i] ?? base
        else break
      }
      const offset = lineStart - base
      const width = info.lineWidthCols?.[local] ?? Bun.stringWidth(source)
      return taskCopyResult(
        row,
        offset === 0 ? sourceLine(match.node, src) : undefined,
        prefix,
        sliceCols(source, offset, width),
        match.gutter,
      )
    }
    if (local >= lines.length) return { text: "", col: match.gutter }
    const text = lines[local] ?? ""
    return taskCopyResult(row, sourceLine(match.node, local), prefix, text, match.gutter)
  }

  function shift(row?: CopyRow, gutter?: number) {
    if (row?.kind !== "tool") return 0
    if (row.tool !== "edit" && row.tool !== "apply_patch") return 0
    if (!gutter) return 0
    return 1
  }

  function copySign(row: CopyRow, cache?: Map<string, any>): string | undefined {
    if (row.kind !== "tool") return undefined
    if (row.tool !== "edit" && row.tool !== "apply_patch") return undefined
    const child = childById(row.id, cache)
    if (!child) return undefined
    const entries = findRenderables(child)
    if (!entries.length) return undefined
    const match = matchingEntry(entries, row)
    const local = row.line - match.y
    const info = match.node.lineInfo
    const src = info?.lineSources ? (info.lineSources[local] ?? local) : local
    const signs = match.node.parent?.getLineSigns?.() as Map<number, { after?: string }> | undefined
    if (!signs) return undefined
    const sign = signs.get(src)
    return sign?.after?.trim()
  }

  function taskDetailIndent(row: CopyRow, text: string) {
    if (row.kind !== "tool" || row.tool !== "task") return 0
    // Task detail rows render under the title text, after the icon/gap.
    return text.trimStart().startsWith("↳") ? 2 : 0
  }

  function copyMin(row?: CopyRow, cache?: Map<string, any>): number {
    if (!row) return 0
    const child = childById(row.id, cache)
    if (!child) return row.col
    const line = copyLine(row, child)
    return row.col + line.col + taskDetailIndent(row, line.text) + shift(row, line.col)
  }

  function motionLine(row: CopyRow, cache?: Map<string, any>): { text: string; min: number; copyable?: boolean } {
    const child = childById(row.id, cache)
    if (!child) return { text: "", min: row.col, copyable: false }
    const entries = findRenderables(child)
    if (!entries.length) return { text: "", min: row.col }
    const match = matchingEntry(entries, row)
    const line = match.table?.display(row.line - match.y) ?? copyLine(row, child)
    const col = match.table ? match.gutter + line.col : line.col
    const text = line.text ?? ""
    return { text, min: row.col + col + taskDetailIndent(row, text) + shift(row, col), copyable: line.copyable }
  }

  function motionMin(row?: CopyRow, cache?: Map<string, any>): number {
    if (!row) return 0
    return motionLine(row, cache).min
  }

  function motionPadded(row: CopyRow, cache?: Map<string, any>): string {
    const line = motionLine(row, cache)
    return " ".repeat(line.min) + line.text
  }

  function motionText(row: CopyRow, cache?: Map<string, any>): string {
    return motionLine(row, cache).text
  }

  function rowPadded(row: CopyRow, cache?: Map<string, any>): string {
    const child = childById(row.id, cache)
    if (!child) return ""
    const line = copyLine(row, child)
    return " ".repeat(row.col + line.col + taskDetailIndent(row, line.text) + shift(row, line.col)) + line.text
  }

  function rowText(row: CopyRow, cache?: Map<string, any>): string {
    const child = childById(row.id, cache)
    if (!child) return ""
    return copyLine(row, child).text ?? ""
  }

  function rowCopyable(row: CopyRow, cache?: Map<string, any>): boolean {
    const child = childById(row.id, cache)
    if (!child) return false
    return copyLine(row, child).copyable !== false
  }

  function signedText(row: CopyRow, cache?: Map<string, any>): string {
    const sign = copySign(row, cache)
    const text = rowText(row, cache)
    if (!sign) return text
    return sign + text
  }

  function signedMotionText(row: CopyRow, cache?: Map<string, any>): string {
    const sign = copySign(row, cache)
    const text = motionText(row, cache)
    if (!sign) return text
    return sign + text
  }

  // --- stick / column ---

  function resolveStick(row: CopyRow, stick: CopyState["stick"], cache?: Map<string, any>): number {
    const scroll = input.scroll()
    const min = motionMin(row, cache)
    const text = motionPadded(row, cache)
    const max = text.length > 0 ? Math.min(scroll.width - 2, text.length - 1) : min
    if (stick === "start") return min
    if (stick === "first") return Math.max(min, Math.min(max, firstNonWhitespace(text, 0)))
    if (stick === "end") return max
    if (typeof stick === "number") return Math.max(min, Math.min(max, min + stick))
    return min
  }

  function copyText(): string {
    const s = state()
    if (!s.active) return ""
    const row = rows()[s.idx]
    if (!row) return ""
    return rowPadded(row)
  }

  function col(): number {
    return state().col
  }

  function setCol(offset: number) {
    const scroll = input.scroll()
    const row = rows()[state().idx]
    const min = motionMin(row)
    const text = motionPadded(row)
    const max = text.length > 0 ? Math.min(scroll.width - 2, text.length - 1) : min
    const c = Math.max(min, Math.min(max, offset))
    setState((s) => ({ ...s, col: c, stick: c - min }))
  }

  function setStick(stick: "start" | "first" | "end") {
    setState((s) => ({ ...s, stick }))
  }

  // --- scroll compensation ---

  let compensateTimer: ReturnType<typeof setTimeout> | undefined

  function scrollOffset(scroll: ScrollBoxRenderable) {
    return scroll.scrollTop ?? scroll.y ?? 0
  }

  function viewportY(scroll: ScrollBoxRenderable) {
    return scroll.y ?? 0
  }

  function scrollToOffset(scroll: ScrollBoxRenderable, top: number) {
    if (typeof scroll.scrollTo === "function") scroll.scrollTo(top)
    else scroll.scrollBy(top - scrollOffset(scroll))
  }

  function scrollByScreenDelta(scroll: ScrollBoxRenderable, delta: number) {
    if (delta === 0) return
    scrollToOffset(scroll, scrollOffset(scroll) + delta)
  }

  function snapshotScroll() {
    const scr = input.scroll()
    if (!scr) return undefined
    const scrollY = scrollOffset(scr)
    const top = viewportY(scr)
    const atBottom = scr.scrollHeight > scr.height && scrollY + scr.height >= scr.scrollHeight - 1
    const children = scr.getChildren().toSorted((a, b) => a.y - b.y)
    const ref = children.find((c) => c.id && c.y + c.height > top)
    if (!ref?.id) return undefined
    return { id: ref.id, childY: ref.y - top, scrollY, atBottom }
  }

  function compensateScroll(snap: ReturnType<typeof snapshotScroll>, afterSettle?: () => void, fast = false) {
    if (compensateTimer) clearTimeout(compensateTimer)
    if (!snap) {
      afterSettle?.()
      return
    }

    const tryCompensate = () => {
      const scr = input.scroll()
      if (!scr || scr.isDestroyed) return false
      const child = scr.getChildren().find((c) => c.id === snap.id)
      if (!child) return false
      const oldAbsolute = snap.scrollY + snap.childY
      const newAbsolute = scrollOffset(scr) + child.y - viewportY(scr)
      const contentDelta = newAbsolute - oldAbsolute
      const cappedDelta = Math.max(-scr.height, Math.min(scr.height, contentDelta))
      if (contentDelta !== 0) {
        if (snap.atBottom) scrollToOffset(scr, scr.scrollHeight)
        else scrollToOffset(scr, snap.scrollY + cappedDelta)
      }
      return true
    }

    let attempts = 0
    let settled = false
    const poll = () => {
      attempts++
      const compensated = tryCompensate()
      if (compensated && !settled && attempts >= 2) {
        settled = true
        afterSettle?.()
      }
      if (attempts >= 10) {
        if (!settled) afterSettle?.()
        return
      }
      compensateTimer = setTimeout(poll, fast && attempts < 4 ? 4 : 16)
    }
    compensateTimer = setTimeout(poll, 0)
  }

  // --- navigation ---

  function sync(next: number) {
    const scroll = input.scroll()
    const list = rows()
    if (!list.length) {
      setState({ ...empty })
      return
    }
    const idx = Math.max(0, Math.min(next, list.length - 1))
    setState((s) => ({ ...s, active: true, idx }))
    const row = list[idx]
    if (!row) return
    const y = row.y
    const top = scroll.y
    const bottom = scroll.y + scroll.height - 1
    if (y < top) {
      scroll.scrollBy(y - top)
      return
    }
    if (y > bottom) {
      scroll.scrollBy(y - bottom)
    }
  }

  function pickVisibleTarget(list: CopyRow[], preferBottom = false) {
    const scr = input.scroll()
    const top = scr.y
    const bottom = scr.y + scr.height - 1
    const visible = list.filter((x) => x.y >= top && x.y <= bottom)
    if (!visible.length) return 0
    if (preferBottom) return list.indexOf(visible[visible.length - 1]!)
    const midY = top + (bottom - top) / 2
    return list.indexOf(visible.reduce((a, b) => (Math.abs(a.y - midY) < Math.abs(b.y - midY) ? a : b)))
  }

  function hasVisibleRow(row?: CopyRow) {
    if (!row) return false
    const scr = input.scroll()
    const top = scr.y
    const bottom = scr.y + scr.height - 1
    return row.y >= top && row.y <= bottom
  }

  function matchingTarget(list: CopyRow[], target: CopyRow) {
    const exact = list.map((row, idx) => ({ row, idx })).filter((x) => x.row.key === target.key)
    if (exact.length) return exact.reduce((a, b) => (Math.abs(a.row.y - target.y) < Math.abs(b.row.y - target.y) ? a : b)).idx
    const candidates = list
      .map((row, idx) => ({ row, idx }))
      .filter((x) => x.row.id === target.id && x.row.kind === target.kind && x.row.role === target.role)
    if (!candidates.length) return -1
    return candidates.reduce((a, b) => (Math.abs(a.row.line - target.line) < Math.abs(b.row.line - target.line) ? a : b)).idx
  }

  function enterTarget(list: CopyRow[], preferVisible = false, preferBottom = false, visibleTarget?: CopyRow) {
    const previous = state()
    if (visibleTarget) {
      const idx = matchingTarget(list, visibleTarget)
      const row = list[idx]
      if (row) return { idx, col: motionMin(row), stick: "first" as const }
    }
    if (preferVisible || previous.idx < 0) {
      const target = pickVisibleTarget(list, preferBottom)
      const row = list[target]
      if (!row) return
      return { idx: target, col: motionMin(row), stick: "first" as const }
    }

    const idx = Math.max(0, Math.min(previous.idx, list.length - 1))
    const row = list[idx]
    if (!row) return
    const min = motionMin(row)
    const text = motionPadded(row)
    return {
      idx,
      col: Math.max(min, Math.min(previous.col, text.length > 0 ? Math.min(input.scroll().width - 2, text.length - 1) : min)),
      stick: previous.stick,
    }
  }

  function enter() {
    const init = () => {
      const beforeRows = rows()
      const previousTarget = lastCursor
      const initial = state().idx < 0 && !previousTarget
      const previousVisible = previousTarget
        ? hasVisibleRow(beforeRows[matchingTarget(beforeRows, previousTarget)])
        : hasVisibleRow(beforeRows[state().idx])
      const preEnterTarget = (preferBottom = false) => beforeRows[pickVisibleTarget(beforeRows, preferBottom)]
      const selectTarget = (preferVisible = false, preferBottom = false, usePreEnterTarget = false, ensureVisible = true) => {
        const list = rows()
        if (!list.length) {
          setState({ ...empty })
          return false
        }
        const target = enterTarget(
          list,
          preferVisible,
          preferBottom,
          usePreEnterTarget && (initial || !previousVisible)
            ? preEnterTarget(preferBottom)
            : !preferVisible
              ? previousTarget
              : undefined,
        )
        if (!target) return false
        setState((s) => ({
          ...s,
          col: target.col,
          stick: target.stick,
          visual: undefined,
          anchor: undefined,
        }))
        if (ensureVisible) sync(target.idx)
        else setState((s) => ({ ...s, active: true, idx: target.idx }))
        return true
      }

      if (!unified()) {
        const snap = snapshotScroll()
        batch(() => {
          setUnified(true)
          setState((s) => ({ ...s, active: true }))
        })
        const preferBottom = initial && snap?.atBottom
        selectTarget(initial || !previousVisible, preferBottom, true, false)
        compensateScroll(snap, () => {
          if (!selectTarget(initial || !previousVisible, preferBottom, true)) setTimeout(() => init(), 0)
        })
        return true
      }

      setState((s) => ({ ...s, active: true }))
      return selectTarget(initial || !previousVisible, false, true, true)
    }
    if (init()) return
    setTimeout(() => init(), 0)
  }

  function clearSearchState() {
    setLastSearch(undefined)
    setActiveSearch(undefined)
  }

  function exit(scrollToBottom?: boolean) {
    if (scrollToBottom === false) {
      exitPreserveScroll()
      return
    }
    lastCursor = undefined
    batch(() => {
      clearSearchState()
      setState({ ...empty })
      setUnified(false)
    })
    input.toBottom()
  }

  function exitPreserveScroll() {
    lastCursor = row()
    const snap = snapshotScroll()
    batch(() => {
      clearSearchState()
      setState((s) => ({ ...s, active: false, visual: undefined, anchor: undefined }))
      setUnified(false)
    })
    compensateScroll(snap, undefined, true)
  }

  function focusInput() {
    exitPreserveScroll()
  }

  function halfPage(direction: "up" | "down") {
    const scr = input.scroll()
    const s = state()
    if (!s.active) return
    const list = rows()
    const current = list[s.idx]
    if (!current) return
    const distance = Math.max(1, Math.floor(scr.height / 4))
    const delta = direction === "up" ? -distance : distance
    const targetY = current.y + delta
    const step = direction === "up" ? -1 : 1
    const next = Math.max(0, Math.min(s.idx + step, list.length - 1))
    let idx = next
    for (let i = next + step; i >= 0 && i < list.length; i += step) {
      if (Math.abs(list[i]!.y - targetY) >= Math.abs(list[idx]!.y - targetY)) break
      idx = i
    }
    scr.scrollBy(delta)
    sync(idx)
    const row = rows()[state().idx]
    if (!row) return
    const col = resolveStick(row, s.stick)
    setState((prev) => ({ ...prev, col }))
  }

  function move(action: "up" | "down" | "left" | "right") {
    const scroll = input.scroll()
    const s = state()
    if (!s.active) return
    if (action === "up" || action === "down") {
      sync(s.idx + (action === "up" ? -1 : 1))
      const row = rows()[state().idx]
      if (!row) return
      const c = resolveStick(row, s.stick)
      setState((prev) => ({ ...prev, col: c }))
      return
    }
    if (action === "left") {
      const row = rows()[s.idx]
      const min = motionMin(row)
      const c = Math.max(min, Math.min(scroll.width - 2, s.col - 1))
      if (c === s.col) return
      setState((prev) => ({ ...prev, col: c, stick: c - min }))
      return
    }
    const row = rows()[s.idx]
    const min = motionMin(row)
    const text = motionPadded(row)
    const max = text.length > 0 ? Math.min(scroll.width - 2, text.length - 1) : min
    const c = Math.max(min, Math.min(max, s.col + 1))
    if (c === s.col) return
    setState((prev) => ({ ...prev, col: c, stick: c - min }))
  }

  function copyToggleVisualEnd() {
    const anchor = state().anchor
    if (!anchor) return
    setState((prev) => {
      const list = rows()
      const row = list[anchor.idx]
      const blockEnd = prev.visual === "block" && prev.stick === "end" && row
      const col = blockEnd ? rowEndCol(row) : anchor.col
      return {
        ...prev,
        idx: anchor.idx,
        col,
        stick: blockEnd ? "end" : col - motionMin(row),
        anchor: { idx: prev.idx, col: blockEnd ? anchor.col : prev.visual === "block" ? blockHeadCol(prev, list) : prev.col },
      }
    })
  }

  function wordRows(list: CopyRow[], cache: Map<string, any>) {
    return list.map((row) => ({ col: motionMin(row, cache) }))
  }

  function wordNext(big: boolean) {
    const s = state()
    if (!s.active) return false
    const list = rows()
    if (!list.length) return false
    const cache = new Map(input.scroll().getChildren().map((c) => [c.id, c]))
    const next = copyWordNext(wordRows(list, cache), (idx) => motionText(list[idx]!, cache), s.idx, s.col, big)
    if (next.idx === s.idx && next.col === s.col) return false
    if (next.idx !== s.idx) sync(next.idx)
    setCol(next.col)
    return true
  }

  function wordPrev(big: boolean) {
    const s = state()
    if (!s.active) return false
    const list = rows()
    if (!list.length) return false
    const cache = new Map(input.scroll().getChildren().map((c) => [c.id, c]))
    const prev = copyWordPrev(wordRows(list, cache), (idx) => motionText(list[idx]!, cache), s.idx, s.col, big)
    if (prev.idx === s.idx && prev.col === s.col) return false
    if (prev.idx !== s.idx) sync(prev.idx)
    setCol(prev.col)
    return true
  }

  function wordEnd(big: boolean) {
    const s = state()
    if (!s.active) return false
    const list = rows()
    if (!list.length) return false
    const cache = new Map(input.scroll().getChildren().map((c) => [c.id, c]))
    const next = copyWordEnd(wordRows(list, cache), (idx) => motionText(list[idx]!, cache), s.idx, s.col, big)
    if (next.idx === s.idx && next.col === s.col) return false
    if (next.idx !== s.idx) sync(next.idx)
    setCol(next.col)
    return true
  }

  function matchingBracket() {
    const s = state()
    if (!s.active) return false
    const list = rows()
    if (!list.length) return false
    const cache = new Map(input.scroll().getChildren().map((c) => [c.id, c]))
    const next = copyMatchingBracket(wordRows(list, cache), (idx) => motionText(list[idx]!, cache), s.idx, s.col)
    if (next.idx === s.idx && next.col === s.col) return false
    if (next.idx !== s.idx) sync(next.idx)
    setCol(next.col)
    return true
  }

  function paragraphColumn(
    row: CopyRow,
    atEnd: boolean,
    sameRow: boolean,
    currentCol: number,
  ): { col: number; stick: "start" | "end" } | null {
    const col = atEnd ? resolveStick(row, "end") : motionMin(row)
    if (sameRow && currentCol === col) return null
    return { col, stick: atEnd ? "end" : "start" }
  }

  function paragraphMove(motion: typeof copyNextParagraph): boolean {
    const s = state()
    if (!s.active) return false
    const list = rows()
    if (!list.length) return false
    const result = motion(list, (idx) => motionText(list[idx]!), s.idx)
    const sameRow = result.index === s.idx
    if (!sameRow) sync(result.index)
    const row = rows()[state().idx]
    if (!row) return false
    const update = paragraphColumn(row, result.atEnd, sameRow, state().col)
    if (!update) return false
    setState((prev) => ({ ...prev, ...update }))
    return true
  }

  function nextParagraph() {
    return paragraphMove(copyNextParagraph)
  }

  function previousParagraph() {
    return paragraphMove(copyPreviousParagraph)
  }

  function rowEndCol(row: CopyRow, cache?: Map<string, any>) {
    const min = motionMin(row, cache)
    const text = motionText(row, cache)
    return text.length > 0 ? min + text.length - 1 : min
  }

  function blockHeadCol(s: CopyState, list = rows(), cache?: Map<string, any>) {
    const row = list[s.idx]
    if (!row) return s.col
    if (s.stick === "end") return rowEndCol(row, cache)
    return s.col
  }

  // --- search ---

  function childCache() {
    return new Map(input.scroll().getChildren().map((c) => [c.id, c]))
  }

  function searchMatches(query: string, list: CopyRow[], cache: Map<string, any>): CopySearchMatch[] {
    const needle = query
    if (!needle) return []
    const sensitive = /[A-Z]/.test(needle)
    const target = sensitive ? needle : needle.toLowerCase()
    return list.flatMap((row, idx) => {
      const text = motionText(row, cache)
      const haystack = sensitive ? text : text.toLowerCase()
      const min = motionMin(row, cache)
      const matches: CopySearchMatch[] = []
      let from = 0
      while (from <= haystack.length) {
        const found = haystack.indexOf(target, from)
        if (found < 0) break
        matches.push({ idx, col: min + found })
        from = found + Math.max(1, target.length)
      }
      return matches
    })
  }

  function currentSearchMatches(query: string) {
    return searchMatches(query, rows(), childCache())
  }

  function pickSearchMatch(matches: CopySearchMatch[], direction: CopySearchDirection, origin: CopySearchOrigin) {
    if (direction === "forward") {
      return matches.find((match) => match.idx > origin.idx || (match.idx === origin.idx && match.col > origin.col)) ?? matches[0]
    }
    return (
      matches.findLast((match) => match.idx < origin.idx || (match.idx === origin.idx && match.col < origin.col)) ??
      matches[matches.length - 1]
    )
  }

  function moveToSearchMatch(match: CopySearchMatch) {
    sync(match.idx)
    const row = rows()[state().idx]
    if (!row) return false
    const min = motionMin(row)
    setState((s) => ({
      ...s,
      col: Math.max(min, match.col),
      stick: Math.max(0, match.col - min),
      visual: undefined,
      anchor: undefined,
    }))
    return true
  }

  function restoreSearchOrigin(search: CopySearch) {
    sync(search.origin.idx)
    setCol(search.origin.col)
  }

  function search(query: string, direction: CopySearchDirection, origin: CopySearchOrigin = state(), commit = true) {
    const matches = currentSearchMatches(query)
    const match = pickSearchMatch(matches, direction, origin)
    if (!match) return false
    if (commit) setLastSearch({ query, direction, origin })
    return moveToSearchMatch(match)
  }

  function startSearch(direction: CopySearchDirection) {
    const s = state()
    setActiveSearch({ query: "", direction, origin: { idx: s.idx, col: s.col } })
  }

  function updateSearch(query: string) {
    const current = activeSearch()
    if (!current) return false
    setActiveSearch({ ...current, query })
    if (!query) {
      setLastSearch(undefined)
      restoreSearchOrigin(current)
      return false
    }
    const found = search(query, current.direction, current.origin, false)
    if (!found) restoreSearchOrigin(current)
    return found
  }

  function appendSearch(value: string) {
    return updateSearch((activeSearch()?.query ?? "") + value)
  }

  function backspaceSearch() {
    return updateSearch((activeSearch()?.query ?? "").slice(0, -1))
  }

  function submitSearch() {
    const current = activeSearch()
    setActiveSearch(undefined)
    if (!current?.query) {
      setLastSearch(undefined)
      return true
    }
    const found = currentSearchMatches(current.query).length > 0
    if (!found) restoreSearchOrigin(current)
    setLastSearch(found ? current : undefined)
    return found
  }

  function cancelSearch() {
    const current = activeSearch()
    if (current) restoreSearchOrigin(current)
    clearSearchState()
  }

  function clearSearch() {
    if (!activeSearch() && !lastSearch()) return false
    clearSearchState()
    return true
  }

  function searchMatchCount() {
    const query = activeSearch()?.query ?? lastSearch()?.query
    if (!query) return 0
    return currentSearchMatches(query).length
  }

  function repeatSearch(reverse = false) {
    const previous = lastSearch()
    if (!previous) return false
    const direction = reverse ? (previous.direction === "forward" ? "backward" : "forward") : previous.direction
    const moved = search(previous.query, direction)
    if (moved && reverse) setLastSearch({ ...previous, origin: state() })
    return moved
  }

  // --- visual ---

  function visual(mode: CopyVisualMode) {
    const s = state()
    if (!s.active) return
    if (s.visual === mode) {
      exitVisual()
      return
    }
    setState((prev) => ({
      ...prev,
      visual: mode,
      anchor: prev.anchor ?? { idx: prev.idx, col: prev.col },
    }))
  }

  function exitVisual() {
    setState((s) => ({ ...s, visual: undefined, anchor: undefined }))
  }

  function rangeText(anchor: Endpoint, head: Endpoint, visual: CopyVisualMode): string {
    const list = rows()
    const cache = new Map(
      input
        .scroll()
        .getChildren()
        .map((c) => [c.id, c]),
    )
    const { start, end } = orderEndpoints(anchor, head)
    if (visual === "line") {
      const lineRows = Array.from({ length: end.idx - start.idx + 1 }, (_, i) => list[start.idx + i])
        .filter((row): row is CopyRow => !!row)
        .filter((row) => rowCopyable(row, cache))
      return lineRows
        .map((row, j) => (j > 0 ? (isWrappedContinuation(row, cache) ? "" : "\n") : "") + signedText(row, cache))
        .join("")
    }
    if (visual === "block") {
      const left = Math.min(anchor.col, head.col)
      const right = Math.max(anchor.col, head.col)
      const endMode = state().stick === "end"
      return Array.from({ length: end.idx - start.idx + 1 }, (_, i) => list[start.idx + i])
        .filter((row): row is CopyRow => !!row)
        .filter((row) => rowCopyable(row, cache))
        .map((row) => {
          const text = motionText(row, cache)
          const min = motionMin(row, cache)
          const rowRight = endMode ? rowEndCol(row, cache) : right
          const rowLeft = endMode && rowRight < anchor.col ? anchor.col : endMode ? Math.min(anchor.col, rowRight) : left
          const selected = `${rowLeft < min ? " ".repeat(min - rowLeft) : ""}${text.slice(
            Math.max(0, rowLeft - min),
            Math.max(0, rowRight - min + 1),
          )}`
          return endMode ? selected : selected.padEnd(right - left + 1, " ")
        })
        .join("\n")
    }
    if (start.idx === end.idx) {
      const row = list[start.idx]
      if (!row) return ""
      const text = motionText(row, cache)
      const min = motionMin(row, cache)
      return text.slice(Math.max(0, start.col - min), Math.max(0, end.col - min + 1))
    }
    const charItems = Array.from({ length: end.idx - start.idx + 1 }, (_, i) => ({ row: list[start.idx + i], i: start.idx + i }))
      .filter((x): x is { row: CopyRow; i: number } => !!x.row)
      .filter((x) => rowCopyable(x.row, cache))
    return charItems
      .map((x, j) => {
        const text = motionText(x.row, cache)
        const min = motionMin(x.row, cache)
        let segment: string
        if (x.i === start.idx) segment = text.slice(Math.max(0, start.col - min))
        else if (x.i === end.idx) segment = text.slice(0, Math.max(0, end.col - min + 1))
        else segment = signedMotionText(x.row, cache)
        return (j > 0 ? (isWrappedContinuation(x.row, cache) ? "" : "\n") : "") + segment
      })
      .join("")
  }

  function selectionText(): string {
    const s = state()
    if (!s.visual || !s.anchor) return ""
    return rangeText(s.anchor, { idx: s.idx, col: s.visual === "block" ? blockHeadCol(s) : s.col }, s.visual)
  }

  function yank() {
    const text = selectionText()
    if (!text) return null
    return { text, linewise: false }
  }

  function yankLine() {
    const list = rows()
    const s = state()
    const row = list[s.idx]
    if (!row) return null
    const cache = new Map(
      input
        .scroll()
        .getChildren()
        .map((c) => [c.id, c]),
    )
    if (!rowCopyable(row, cache)) return null
    const text = signedText(row, cache)
    setYankLineFlash(s.idx)
    setTimeout(() => setYankLineFlash(undefined), 70)
    return { text, linewise: false }
  }

  function yankMatchingBracket() {
    const s = state()
    if (!s.active) return null
    const list = rows()
    if (!list.length) return null
    const cache = new Map(
      input
        .scroll()
        .getChildren()
        .map((c) => [c.id, c]),
    )
    const next = copyMatchingBracket(wordRows(list, cache), (idx) => motionText(list[idx]!, cache), s.idx, s.col)
    if (next.idx === s.idx && next.col === s.col) return null
    const current = { idx: s.idx, col: s.col }
    const text = rangeText(current, next, "char")
    if (!text) return null
    flashYankRange(current, next)
    return { text, linewise: false }
  }

  async function copy() {
    const text = selectionText()
    if (!text) return
    await writeClipboard(text)
  }

  function isToolToggleRow(row: CopyRow) {
    if (row.kind !== "tool") return false
    const text = rowText(row).trim().toLowerCase()
    return text === "click to expand" || text === "click to collapse"
  }

  function toolToggleText(row: CopyRow) {
    if (row.kind !== "tool") return undefined
    const text = rowText(row).trim().toLowerCase()
    if (text === "click to expand" || text === "click to collapse") return text
    return undefined
  }

  function lastToolToggleIndex(list: CopyRow[], id: string, expectedText?: string) {
    return list.findLastIndex((candidate) => {
      if (candidate.id !== id) return false
      const text = toolToggleText(candidate)
      return expectedText ? text === expectedText : !!text
    })
  }

  function settleToolToggle(
    id: string,
    expectedText: string,
    apply: (idx: number, row: CopyRow) => void,
    afterSettle?: () => void,
  ) {
    if (compensateTimer) clearTimeout(compensateTimer)

    const tryApply = () => {
      const scr = input.scroll()
      if (!scr || scr.isDestroyed) return false
      const list = rows()
      const idx = lastToolToggleIndex(list, id, expectedText)
      const next = list[idx]
      if (!next) return false
      apply(idx, next)
      return true
    }

    let attempts = 0
    let settled = false
    const poll = () => {
      attempts++
      const applied = tryApply()
      if (applied && !settled && attempts >= 2) {
        settled = true
        afterSettle?.()
      }
      if (attempts >= 10) {
        if (!settled) afterSettle?.()
        return
      }
      compensateTimer = setTimeout(poll, attempts < 4 ? 4 : 16)
    }
    compensateTimer = setTimeout(poll, 0)
  }

  function revealToolToggle(id: string, expectedText: string, afterSettle?: () => void) {
    settleToolToggle(id, expectedText, (idx) => sync(idx), afterSettle)
  }

  function preserveToolToggleOffset(id: string, expectedText: string, offset: number, afterSettle?: () => void) {
    settleToolToggle(
      id,
      expectedText,
      (_, row) => {
        const scr = input.scroll()
        scrollByScreenDelta(scr, row.y - viewportY(scr) - offset)
      },
      afterSettle,
    )
  }

  function activate() {
    const s = state()
    if (!s.active) return false
    const row = rows()[s.idx]
    if (!row || !rowText(row).trim()) return false
    return input.activate?.(row) ?? false
  }

  function toggleCollapsed() {
    const s = state()
    if (!s.active) return false
    const list = rows()
    const row = list[s.idx]
    if (!row || !isToolToggleRow(row)) return false
    if (lastToolToggleIndex(list, row.id) !== s.idx) return false
    const text = rowText(row).trim().toLowerCase()
    const expanding = text === "click to expand"
    const offset = row.y - viewportY(input.scroll())
    const targetID = row.id
    const expectedText = expanding ? "click to collapse" : "click to expand"
    const toggled = Boolean(input.toggleCollapsed?.(row.id) || (row.part ? input.toggleCollapsed?.(row.part) : false))
    if (toggled) {
      const restoreCursor = () => {
        const list = rows()
        const idx = lastToolToggleIndex(list, targetID, expectedText)
        const next = list[idx]
        if (!next) return
        if (expanding) sync(idx)
        else setState((prev) => ({ ...prev, active: true, idx }))
        setState((prev) => ({ ...prev, col: copyMin(next), stick: "first" }))
      }
      if (expanding) revealToolToggle(targetID, expectedText, restoreCursor)
      else preserveToolToggleOffset(targetID, expectedText, offset, restoreCursor)
    }
    return toggled
  }

  // --- jumps ---

  function jump(action: "top" | "bottom" | "high" | "middle" | "low") {
    const scroll = input.scroll()
    const list = rows()
    if (!list.length) return
    if (action === "top" || action === "bottom") {
      sync(action === "top" ? 0 : list.length - 1)
      const row = rows()[state().idx]
      if (!row) return
      const c = resolveStick(row, state().stick)
      setState((s) => ({ ...s, col: c }))
      return
    }
    const top = scroll.y
    const bottom = scroll.y + scroll.height - 1
    const first = list.findIndex((r) => r.y >= top && r.y <= bottom)
    const last = list.findLastIndex((r) => r.y >= top && r.y <= bottom)
    if (first < 0) return
    let target = first
    if (action === "low") target = last
    if (action === "middle") target = Math.round((first + last) / 2)
    sync(target)
    const row = rows()[state().idx]
    if (!row) return
    const c = resolveStick(row, state().stick)
    setState((s) => ({ ...s, col: c }))
  }

  function scroll(action: "center" | "top" | "bottom") {
    const scr = input.scroll()
    const s = state()
    if (!s.active) return
    const row = rows()[s.idx]
    if (!row) return
    if (action === "top") scr.scrollBy(row.y - scr.y)
    if (action === "center") scr.scrollBy(row.y - scr.y - Math.floor(scr.height / 2))
    if (action === "bottom") scr.scrollBy(row.y - scr.y - scr.height + 1)
  }

  function clamp(delta: number) {
    const scr = input.scroll()
    if (!state().active) return
    const list = rows()
    if (!list.length) return
    const s = state()
    const idx = Math.max(0, Math.min(s.idx, list.length - 1))
    const row = list[idx]
    if (!row) return
    const top = scr.y
    const bottom = scr.y + scr.height - 1
    if (row.y >= top && row.y <= bottom) return
    const first = list.findIndex((r) => r.y >= top && r.y <= bottom)
    const last = list.findLastIndex((r) => r.y >= top && r.y <= bottom)
    let target = -1
    if (row.y < top && first >= 0) target = first
    if (row.y > bottom && last >= 0) target = last
    if (target < 0 && delta > 0) {
      target = list.findIndex((r) => r.y > bottom)
      if (target < 0) target = list.findLastIndex((r) => r.y < top)
    }
    if (target < 0 && delta < 0) {
      target = list.findLastIndex((r) => r.y < top)
      if (target < 0) target = list.findIndex((r) => r.y > bottom)
    }
    if (target < 0) return
    const resolved = list[target]
    if (!resolved) return
    const c = resolveStick(resolved, s.stick)
    setState((prev) => ({ ...prev, idx: target, col: c }))
  }

  // --- effects ---

  createEffect((prev: string | undefined) => {
    const id = input.session()
    if (prev !== undefined && prev !== id) exit()
    return id
  })

  createEffect(() => {
    const s = state()
    const list = rows()
    if (!s.active) return
    if (!list.length) {
      exit()
      return
    }
    if (s.idx >= list.length) {
      sync(list.length - 1)
    }
  })

  // --- derived ---

  const row = createMemo(() => {
    const s = state()
    if (!s.active) return undefined
    return rows()[s.idx]
  })

  const rowHasText = createMemo(() => {
    const current = row()
    return current ? Boolean(rowText(current).trim()) : false
  })

  const highlights = createMemo(() => {
    const s = state()
    const out = new Map<string, CopyHighlight[]>()
    if (!s.active) return out
    const flashIdx = yankLineFlash()
    const addHighlight = (
      row: CopyRow,
      min: number,
      text: string,
      left: number,
      right: number,
      options?: Pick<CopyHighlight, "kind" | "current"> & { placeholder?: boolean },
    ) => {
      if (left > right) return
      const selected = text.slice(Math.max(0, left - min), Math.max(0, right - min + 1))
      if (!selected && !options?.placeholder) return
      const start = Math.max(left, min)
      const entry: CopyHighlight = {
        line: row.line,
        left: start,
        right: start + Math.max(1, selected.length) - 1,
        text: selected || " ",
        ...(options?.kind ? { kind: options.kind } : {}),
        ...(options?.current ? { current: true } : {}),
      }
      const arr = out.get(row.id)
      if (arr) arr.push(entry)
      else out.set(row.id, [entry])
    }

    const flashRange = yankRangeFlash()
    const list = rows()
    const cache = childCache()

    const searchQuery = activeSearch() ? activeSearch()?.query : lastSearch()?.query
    if (searchQuery) {
      for (const match of searchMatches(searchQuery, list, cache)) {
        const row = list[match.idx]
        if (!row) continue
        const line = motionLine(row, cache)
        if (line.copyable === false) continue
        addHighlight(row, line.min, line.text, match.col, match.col + searchQuery.length - 1, {
          kind: "search",
          current: match.idx === s.idx && match.col === s.col,
        })
      }
    }

    if (flashIdx !== undefined) {
      const row = list[flashIdx]
      if (row) {
        const line = motionLine(row, cache)
        if (line.copyable !== false) {
          const max = line.text.length > 0 ? line.min + line.text.length - 1 : line.min
          addHighlight(row, line.min, line.text, line.min, max)
        }
      }
    }

    if (flashRange) {
      for (let i = flashRange.start.idx; i <= flashRange.end.idx; i++) {
        const r = list[i]
        if (!r) continue
        const line = motionLine(r, cache)
        if (line.copyable === false) continue
        const max = line.text.length > 0 ? line.min + line.text.length - 1 : line.min
        addHighlight(
          r,
          line.min,
          line.text,
          i === flashRange.start.idx ? flashRange.start.col : line.min,
          i === flashRange.end.idx ? flashRange.end.col : max,
        )
      }
    }

    if (!s.visual || !s.anchor) return out
    const h = { idx: s.idx, col: s.visual === "block" ? blockHeadCol(s, list, cache) : s.col }
    const { start, end } = orderEndpoints(s.anchor, h)
    const blockLeft = Math.min(s.anchor.col, h.col)
    const blockRight = Math.max(s.anchor.col, h.col)
    const blockEnd = s.visual === "block" && s.stick === "end"

    for (let i = start.idx; i <= end.idx; i++) {
      const r = list[i]
      if (!r) continue
      const line = motionLine(r, cache)
      if (line.copyable === false) continue
      const max = line.text.length > 0 ? line.min + line.text.length - 1 : line.min
      const left =
        s.visual === "line"
          ? line.min
          : s.visual === "block"
            ? blockEnd && max < s.anchor.col
              ? s.anchor.col
              : blockEnd
                ? Math.min(s.anchor.col, max)
                : blockLeft
            : i === start.idx && i === end.idx
              ? start.col
              : i === start.idx
                ? start.col
                : line.min
      const right =
        s.visual === "line"
          ? max
          : s.visual === "block"
            ? blockEnd
              ? Math.max(s.anchor.col, max)
              : blockRight
            : i === start.idx && i === end.idx
              ? end.col
              : i === end.idx
              ? end.col
              : max
      if (i !== h.idx) {
        addHighlight(r, line.min, line.text, left, right, { placeholder: true })
        continue
      }
      // cursor cell is painted separately by CopyOverlay so the cursor keeps its theme.text color
      addHighlight(r, line.min, line.text, left, h.col - 1, { placeholder: true })
      addHighlight(r, line.min, line.text, h.col + 1, right, { placeholder: true })
    }
    return out
  })

  const cursorCol = createMemo(() => {
    const s = state()
    if (!s.active) return 0
    const row = rows()[s.idx]
    if (!row) return s.col
    const line = motionLine(row)
    const max = line.text.length > 0 ? line.min + line.text.length - 1 : line.min
    return Math.max(line.min, Math.min(max, s.col))
  })

  const cursorText = createMemo(() => {
    const s = state()
    if (!s.active) return " "
    const row = rows()[s.idx]
    if (!row) return " "
    const line = motionLine(row)
    const cursor = cursorCol()
    let col = 0
    for (const seg of segmenter.segment(line.text)) {
      if (line.min + col >= cursor) return seg.segment
      col += Bun.stringWidth(seg.segment)
    }
    return " "
  })

  const action = createMemo(() => {
    const s = state()
    if (!s.active || s.visual) return undefined
    const list = rows()
    const row = list[s.idx]
    if (row && isToolToggleRow(row) && lastToolToggleIndex(list, row.id) === s.idx) {
      const text = rowText(row).trim()
      if (text) return { kind: "tool-toggle" as const, left: copyMin(row), text }
    }
    return undefined
  })

  return {
    prompt: {
      enter,
      exit,
      exitPreserveScroll,
      focusInput,
      visual,
      yank,
      yankLine,
      yankMatchingBracket,
      copy,
      toggleCollapsed,
      activate,
      isVisual: () => !!state().visual,
      exitVisual,
      visualMode: () => state().visual,
      move,
      halfPage,
      jump,
      wordNext,
      wordPrev,
      wordEnd,
      matchingBracket,
      nextParagraph,
      previousParagraph,
      searchStart: startSearch,
      searchAppend: appendSearch,
      searchBackspace: backspaceSearch,
      searchSubmit: submitSearch,
      searchCancel: cancelSearch,
      searchClear: clearSearch,
      searchActive: () => activeSearch() !== undefined,
      searchHighlighted: () => activeSearch() !== undefined || lastSearch() !== undefined,
      searchMatchCount,
      searchDisplay: () => {
        const search = activeSearch()
        if (!search) return undefined
        return `${search.direction === "forward" ? "/" : "?"}${search.query}`
      },
      searchNext: () => repeatSearch(false),
      searchPrevious: () => repeatSearch(true),
      text: copyText,
      col,
      setCol,
      setStick,
      scroll,
      copyToggleVisualEnd,
      active: () => state().active,
    } satisfies CopyModeAdapter,
    row,
    rowHasText,
    highlights,
    active: () => state().active,
    unified,
    clamp,
    state,
    cursorCol,
    cursorText,
    action,
  }
}
