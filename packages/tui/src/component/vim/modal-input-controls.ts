import type { KeyEvent } from "@opentui/core"
import {
  createSingleLineVimMotions,
  isSingleLineVimPrintableKey,
  singleLineVimKeyName,
  singleLineVimLangmappedEvent,
  type SingleLineVimKeyEvent,
} from "./single-line-vim-motions"

export type ModalInputMode = "insert" | "normal"

export type ModalInputKeyEvent = SingleLineVimKeyEvent

export function createModalInputControls(input: {
  mode: () => ModalInputMode
  setMode: (mode: ModalInputMode) => void
  move?: (direction: 1 | -1) => void
  moveToStart?: () => void
  moveToEnd?: () => void
  focus: () => void
  text: () => string
  cursor: () => number
  setCursor: (offset: number) => void
  setText: (text: string) => void
  langmap?: () => Record<string, string> | undefined
  vimEscapeSequence?: () => string | undefined
}) {
  let pending = ""
  const enterNormal = () => {
    input.setCursor(normalCursor(input.text(), input.cursor()))
    input.setMode("normal")
  }
  const escapeSequence = createModalInputEscapeSequence({
    vimEscapeSequence: input.vimEscapeSequence,
    text: input.text,
    cursor: input.cursor,
    setCursor: input.setCursor,
    setText: input.setText,
    enterNormal,
  })
  const motions = createSingleLineVimMotions({
    text: input.text,
    cursor: input.cursor,
    setCursor: input.setCursor,
    setText: input.setText,
    enterInsert: () => input.setMode("insert"),
    focus: input.focus,
  })

  return {
    clearPending() {
      pending = ""
      motions.clearPending()
      escapeSequence.clearPending()
    },
    enterNormal,
    handleKey(event: ModalInputKeyEvent) {
      if (hasModifier(event)) {
        pending = ""
        motions.handleKey(event)
        escapeSequence.clearPending()
        return false
      }
      const mappedEvent = input.mode() === "normal" ? singleLineVimLangmappedEvent(event, input.langmap) : event
      const key = keyName(mappedEvent)
      if (input.mode() === "insert") {
        if (key === "escape") {
          pending = ""
          escapeSequence.clearPending()
          enterNormal()
          event.preventDefault()
          return true
        }
        return escapeSequence.handleKey(event)
      }

      if (key === "escape") return false
      if (key === "i" || key === "a" || key === "/") {
        pending = ""
        motions.clearPending()
        if (key === "a") input.setCursor(Math.min(input.text().length, input.cursor() + 1))
        input.setMode("insert")
        input.focus()
        mappedEvent.preventDefault()
        return true
      }
      if (motions.handleKey(mappedEvent)) {
        pending = ""
        return true
      }
      if (input.move && key === "j") {
        pending = ""
        input.move(1)
        mappedEvent.preventDefault()
        return true
      }
      if (input.move && key === "k") {
        pending = ""
        input.move(-1)
        mappedEvent.preventDefault()
        return true
      }
      if (input.moveToEnd && key === "G") {
        pending = ""
        input.moveToEnd()
        mappedEvent.preventDefault()
        return true
      }
      if (input.moveToStart && key === "g") {
        if (pending === "g") {
          pending = ""
          input.moveToStart()
          mappedEvent.preventDefault()
          return true
        }
        pending = "g"
        mappedEvent.preventDefault()
        return true
      }

      pending = ""
      if (isSingleLineVimPrintableKey(key) || key === "backspace" || key === "delete") {
        mappedEvent.preventDefault()
        return true
      }
      return false
    },
  }
}

export function createModalInputEscapeSequence(input: {
  vimEscapeSequence: (() => string | undefined) | undefined
  text: () => string
  cursor: () => number
  setCursor: (offset: number) => void
  setText: (text: string) => void
  enterNormal: () => void
}) {
  let pending: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function cancelPending() {
    pending = undefined
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  function insert(value: string) {
    const cursor = input.cursor()
    input.setText(input.text().slice(0, cursor) + value + input.text().slice(cursor))
    input.setCursor(cursor + value.length)
  }

  function clearPending() {
    const value = pending
    cancelPending()
    if (value) insert(value)
  }

  return {
    clearPending,
    handleKey(event: ModalInputKeyEvent) {
      const sequence = input.vimEscapeSequence?.()
      if (!sequence) {
        clearPending()
        return false
      }
      const key = singleLineVimKeyName(event)
      if (pending) {
        if (key !== sequence[1] || hasModifier(event)) {
          clearPending()
          return false
        }
        cancelPending()
        input.enterNormal()
        event.preventDefault()
        return true
      }
      if (key !== sequence[0] || hasModifier(event)) return false
      pending = sequence[0]
      timer = setTimeout(clearPending, 300)
      event.preventDefault()
      return true
    },
  }
}

function hasModifier(event: KeyEvent) {
  return !!event.ctrl || !!event.meta || !!event.super || !!event.hyper || !!event.option
}

function normalCursor(text: string, cursor: number) {
  if (text.length === 0) return 0
  return Math.max(0, Math.min(cursor - 1, text.length - 1))
}

function keyName(event: KeyEvent) {
  if (event.name === "escape") return "escape"
  if (event.shift && event.name === "g") return "G"
  return singleLineVimKeyName(event)
}
