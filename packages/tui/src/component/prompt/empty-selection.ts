export function emptyRows(
  text: string,
  sel: { start: number; end: number } | null,
  info: { lineSources: number[]; lineWidthCols: number[] },
  scroll: number,
  height: number,
) {
  if (!sel) return []
  const lines = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lines.push(i + 1)
  }
  const end = Math.min(scroll + height, info.lineSources.length)
  return info.lineSources.slice(scroll, end).flatMap((line, row) => {
    if (info.lineWidthCols[scroll + row] !== 0) return []
    const start = lines[line]
    if (start === undefined) return []
    return sel.start <= start && start < sel.end ? [row] : []
  })
}
