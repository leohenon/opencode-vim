import type { OptimizedBuffer, RGBA, TextareaRenderable } from "@opentui/core"

const SHOWBREAK_MARKER = "↪ "

type ShowbreakTarget = Pick<TextareaRenderable, "x" | "y" | "height" | "scrollY" | "lineInfo">

export function showbreakRows(info: { lineWraps: number[] }, scroll: number, height: number) {
  const end = Math.min(scroll + height, info.lineWraps.length)
  return info.lineWraps.slice(scroll, end).flatMap((wrap, row) => (wrap > 0 ? [row] : []))
}

export function drawShowbreak(
  buffer: Pick<OptimizedBuffer, "drawText">,
  target: ShowbreakTarget,
  enabled: boolean,
  foreground: RGBA,
  background: RGBA,
) {
  if (!enabled || target.x < 2) return
  for (const row of showbreakRows(target.lineInfo, target.scrollY, target.height)) {
    buffer.drawText(SHOWBREAK_MARKER, target.x - 2, target.y + row, foreground, background)
  }
}
