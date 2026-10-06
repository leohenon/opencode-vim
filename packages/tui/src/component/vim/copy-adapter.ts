import type { VimRegister } from "./vim-state"

export type CopySearchDirection = "forward" | "backward"
export type CopyVisualMode = "char" | "line" | "block"

// Contract between copy mode (routes/session/copy-mode.ts) and the prompt's
// vim handler. createCopyMode().prompt implements this interface.
export type CopyModeAdapter = {
  enter: () => void
  exit: (scrollToBottom?: boolean) => void
  exitPreserveScroll: () => void
  focusInput: () => void
  visual: (mode: CopyVisualMode) => void
  yank: () => VimRegister
  yankLine: () => VimRegister
  yankMatchingBracket: () => VimRegister
  copy: () => Promise<void> | void
  toggleCollapsed: () => boolean
  activate: () => boolean
  isVisual: () => boolean
  exitVisual: () => void
  visualMode: () => undefined | CopyVisualMode
  move: (action: "up" | "down" | "left" | "right") => void
  halfPage: (direction: "up" | "down") => void
  jump: (action: "top" | "bottom" | "high" | "middle" | "low") => void
  wordNext: (big: boolean) => boolean
  wordPrev: (big: boolean) => boolean
  wordEnd: (big: boolean) => boolean
  matchingBracket: () => boolean
  nextParagraph: () => boolean
  previousParagraph: () => boolean
  searchStart: (direction: CopySearchDirection) => void
  searchAppend: (value: string) => boolean
  searchBackspace: () => boolean
  searchSubmit: () => boolean
  searchCancel: () => void
  searchClear: () => boolean
  searchActive: () => boolean
  searchHighlighted: () => boolean
  searchMatchCount: () => number
  searchDisplay: () => string | undefined
  searchNext: () => boolean
  searchPrevious: () => boolean
  text: () => string
  col: () => number
  setCol: (offset: number) => void
  setStick: (stick: "start" | "first" | "end") => void
  scroll: (action: "center" | "top" | "bottom") => void
  copyToggleVisualEnd: () => void
  active: () => boolean
}
