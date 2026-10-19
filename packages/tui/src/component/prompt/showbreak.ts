import type { OptimizedBuffer, RGBA, TextareaRenderable } from "@opentui/core"

const SHOWBREAK_MARKER = "↪ "

// ocv: v2 renderables expose absolute screen coordinates separately from the
// layout coordinates, the marker has to be drawn on the screen.
type ShowbreakTarget = Pick<TextareaRenderable, "screenX" | "screenY" | "height" | "scrollY" | "lineInfo">

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
  if (!enabled || target.screenX < 2) return
  for (const row of showbreakRows(target.lineInfo, target.scrollY, target.height)) {
    buffer.drawText(SHOWBREAK_MARKER, target.screenX - 2, target.screenY + row, foreground, background)
  }
}
