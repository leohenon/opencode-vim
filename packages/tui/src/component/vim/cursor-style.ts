export type VimCursorStyle = {
  style: "block" | "underline" | "line" | "default"
  blinking: boolean
}

const INSERT_CURSOR = { style: "line", blinking: true } as const
const NORMAL_CURSOR = { style: "block", blinking: false } as const
const REPLACE_CURSOR = { style: "underline", blinking: false } as const

export function vimCursorStyle(
  mode: "normal" | "insert" | "replace" | undefined,
  configured?: VimCursorStyle,
): VimCursorStyle {
  if (mode === "normal") return NORMAL_CURSOR
  if (mode === "replace") return REPLACE_CURSOR
  return configured ?? INSERT_CURSOR
}
