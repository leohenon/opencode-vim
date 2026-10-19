import type { KeyEvent } from "@opentui/core"
import { applyLangmap } from "./vim-langmap"

export type SingleLineVimKeyEvent = KeyEvent & {
  preventDefault(): void
  defaultPrevented?: boolean
}

export function createSingleLineVimMotions(input: {
  text: () => string
  cursor: () => number
  setCursor: (offset: number) => void
  setText: (text: string) => void
  enterInsert: () => void
  focus: () => void
  langmap?: () => Record<string, string> | undefined
}) {
  let pending = ""

  return {
    clearPending() {
      pending = ""
    },
    handleKey(event: SingleLineVimKeyEvent) {
      if (hasModifier(event)) {
        pending = ""
        return false
      }
      const mappedEvent = singleLineVimLangmappedEvent(event, input.langmap)
      const key = singleLineVimKeyName(mappedEvent)
      if (key === "d") {
        if (pending === "d") {
          pending = ""
          input.setText("")
          input.setCursor(0)
          mappedEvent.preventDefault()
          return true
        }
        pending = "d"
        mappedEvent.preventDefault()
        return true
      }

      pending = ""
      if (key === "s") {
        const text = input.text()
        const cursor = input.cursor()
        if (cursor < text.length) {
          input.setText(text.slice(0, cursor) + text.slice(cursor + 1))
          input.setCursor(Math.min(cursor, text.length - 1))
        }
        input.enterInsert()
        input.focus()
        mappedEvent.preventDefault()
        return true
      }
      if (key === "S") {
        input.setText("")
        input.setCursor(0)
        input.enterInsert()
        input.focus()
        mappedEvent.preventDefault()
        return true
      }
      if (key === "h") {
        input.setCursor(Math.max(0, input.cursor() - 1))
        mappedEvent.preventDefault()
        return true
      }
      if (key === "l") {
        input.setCursor(Math.min(normalCursorEnd(input.text()), input.cursor() + 1))
        mappedEvent.preventDefault()
        return true
      }
      if (key === "b") {
        input.setCursor(previousWordStart(input.text(), input.cursor()))
        mappedEvent.preventDefault()
        return true
      }
      if (key === "w") {
        input.setCursor(nextWordStart(input.text(), input.cursor()))
        mappedEvent.preventDefault()
        return true
      }
      if (key === "e") {
        input.setCursor(nextWordEnd(input.text(), input.cursor()))
        mappedEvent.preventDefault()
        return true
      }
      if (key === "0") {
        input.setCursor(0)
        mappedEvent.preventDefault()
        return true
      }
      if (key === "$") {
        input.setCursor(normalCursorEnd(input.text()))
        mappedEvent.preventDefault()
        return true
      }
      if (key === "I") {
        input.setCursor(0)
        input.enterInsert()
        input.focus()
        mappedEvent.preventDefault()
        return true
      }
      if (key === "A") {
        input.setCursor(input.text().length)
        input.enterInsert()
        input.focus()
        mappedEvent.preventDefault()
        return true
      }
      return false
    },
  }
}

export function singleLineVimKeyName(event: KeyEvent) {
  if (event.name === "backspace" || event.sequence === "\b" || event.sequence === "\x7f" || event.raw === "\b" || event.raw === "\x7f") return "backspace"
  if (event.name === "delete") return "delete"
  if (event.name === "slash" || event.sequence === "/" || event.raw === "/") return "/"
  const text = event.sequence?.length === 1 ? event.sequence : event.raw?.length === 1 ? event.raw : undefined
  if (text) return text
  if (event.shift && event.name === "i") return "I"
  if (event.shift && event.name === "a") return "A"
  if (event.shift && event.name === "s") return "S"
  if (event.shift && event.name === "4") return "$"
  return event.name ?? ""
}

export function isSingleLineVimPrintableKey(key: string) {
  return key.length === 1 || key === "space"
}

export function singleLineVimLangmappedEvent(
  event: SingleLineVimKeyEvent,
  langmap: (() => Record<string, string> | undefined) | undefined,
): SingleLineVimKeyEvent {
  return applyLangmap(event, singleLineVimKeyName(event), langmap?.())
}

function hasModifier(event: KeyEvent) {
  return !!event.ctrl || !!event.meta || !!event.super || !!event.hyper || !!event.option
}

function normalCursorEnd(text: string) {
  return Math.max(0, text.length - 1)
}

function previousWordStart(text: string, cursor: number) {
  const before = text.slice(0, Math.max(0, cursor))
  const match = before.match(/\S+\s*$/)
  return match ? before.length - match[0].length : 0
}

function nextWordStart(text: string, cursor: number) {
  const end = normalCursorEnd(text)
  const start = Math.min(text.length, cursor)
  const wordEnd = text[start] && /\S/.test(text[start]) ? text.slice(start).search(/\s/) : 0
  const afterWord = wordEnd === -1 ? text.length : start + wordEnd
  const match = text.slice(afterWord).match(/\S/)
  return match?.index === undefined ? end : Math.min(end, afterWord + match.index)
}

function nextWordEnd(text: string, cursor: number) {
  const end = normalCursorEnd(text)
  const start = Math.min(text.length, cursor)
  const next = text[start] && /\S/.test(text[start]) ? start + 1 : start
  const word = text.slice(next).match(/\S+/)
  return word?.index === undefined ? end : Math.min(end, next + word.index + word[0].length - 1)
}
