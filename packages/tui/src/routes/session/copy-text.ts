const segmenter = new Intl.Segmenter()

type CellSegment = {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly cell: number
  readonly width: number
}

export function cellSegments(text: string): CellSegment[] {
  let cell = 0
  return Array.from(segmenter.segment(text), (item) => {
    const width = Bun.stringWidth(item.segment)
    const result = {
      text: item.segment,
      start: item.index,
      end: item.index + item.segment.length,
      cell,
      width,
    }
    cell += width
    return result
  })
}

export function cellWidth(text: string) {
  return Bun.stringWidth(text)
}

export function offsetToCell(text: string, offset: number) {
  const segment = cellSegments(text).find((item) => offset < item.end)
  return segment?.cell ?? cellWidth(text)
}

export function cellToOffset(text: string, cell: number, edge: "start" | "end" = "start") {
  const segments = cellSegments(text)
  const segment = segments.find((item) => cell < item.cell + Math.max(1, item.width))
  if (!segment) return text.length
  return edge === "end" && cell > segment.cell ? segment.end : segment.start
}

export function sliceCells(text: string, start: number, end: number) {
  if (end <= start) return ""
  const selected = cellSegments(text).filter(
    (item) => item.cell < end && item.cell + Math.max(1, item.width) > start,
  )
  const first = selected[0]
  const last = selected.at(-1)
  return first && last ? text.slice(first.start, last.end) : ""
}

export function previousCell(text: string, cell: number) {
  return cellSegments(text).findLast((item) => item.cell < cell)?.cell ?? 0
}

export function nextCell(text: string, cell: number) {
  const segments = cellSegments(text)
  const current = segments.find((item) => cell < item.cell + Math.max(1, item.width))
  if (!current) return cellWidth(text)
  return current.cell + Math.max(1, current.width)
}

export function cellAt(text: string, cell: number) {
  return cellSegments(text).find((item) => cell < item.cell + Math.max(1, item.width))?.text ?? " "
}

export function padCells(text: string, width: number) {
  return text + " ".repeat(Math.max(0, width - cellWidth(text)))
}
