import { describe, expect, test } from "bun:test"
import { createSingleLineVimMotions, type SingleLineVimKeyEvent } from "../src/component/vim/single-line-vim-motions"

function key(name: string, input?: { sequence?: string; shift?: boolean; ctrl?: boolean; option?: boolean; hyper?: boolean }) {
  let prevented = false
  return {
    name,
    sequence: input?.sequence,
    shift: input?.shift,
    ctrl: input?.ctrl,
    option: input?.option,
    hyper: input?.hyper,
    preventDefault() {
      prevented = true
    },
    get defaultPrevented() {
      return prevented
    },
  } as SingleLineVimKeyEvent
}

function createMotions(input: { text?: string; cursor?: number; langmap?: Record<string, string> } = {}) {
  let text = input.text ?? ""
  let cursor = input.cursor ?? 0
  let insert = false
  const motions = createSingleLineVimMotions({
    text: () => text,
    cursor: () => cursor,
    setCursor: (next) => (cursor = next),
    setText: (next) => (text = next),
    enterInsert: () => (insert = true),
    focus() {},
    langmap: () => input.langmap,
  })

  return { motions, cursor: () => cursor, insert: () => insert, text: () => text }
}

describe("single line vim motions", () => {
  test("moves by character, word, and line", () => {
    const state = createMotions({ text: "alpha beta gamma", cursor: 6 })

    state.motions.handleKey(key("h"))
    expect(state.cursor()).toBe(5)
    state.motions.handleKey(key("l"))
    expect(state.cursor()).toBe(6)
    state.motions.handleKey(key("w"))
    expect(state.cursor()).toBe(11)
    state.motions.handleKey(key("b"))
    expect(state.cursor()).toBe(6)
    state.motions.handleKey(key("e"))
    expect(state.cursor()).toBe(9)
    state.motions.handleKey(key("0"))
    expect(state.cursor()).toBe(0)
    state.motions.handleKey(key("4", { sequence: "$", shift: true }))
    expect(state.cursor()).toBe(15)
  })

  test("enters insert at start and end", () => {
    const start = createMotions({ text: "alpha", cursor: 2 })
    start.motions.handleKey(key("i", { sequence: "I", shift: true }))
    expect(start.cursor()).toBe(0)
    expect(start.insert()).toBe(true)

    const end = createMotions({ text: "alpha", cursor: 2 })
    end.motions.handleKey(key("a", { sequence: "A", shift: true }))
    expect(end.cursor()).toBe(5)
    expect(end.insert()).toBe(true)
  })

  test("applies langmap to motions", () => {
    const state = createMotions({ text: "alpha", cursor: 2, langmap: { р: "h", д: "l", ш: "i" } })

    state.motions.handleKey(key("р", { sequence: "р" }))
    expect(state.cursor()).toBe(1)
    state.motions.handleKey(key("д", { sequence: "д" }))
    expect(state.cursor()).toBe(2)
    state.motions.handleKey(key("ш", { sequence: "Ш", shift: true }))
    expect(state.cursor()).toBe(0)
    expect(state.insert()).toBe(true)
  })

  test("substitutes the character under cursor", () => {
    const state = createMotions({ text: "alpha", cursor: 2 })

    state.motions.handleKey(key("s"))

    expect(state.text()).toBe("alha")
    expect(state.cursor()).toBe(2)
    expect(state.insert()).toBe(true)
  })

  test("substitutes the last character under cursor", () => {
    const state = createMotions({ text: "alpha", cursor: 4 })

    state.motions.handleKey(key("s"))

    expect(state.text()).toBe("alph")
    expect(state.cursor()).toBe(4)
    expect(state.insert()).toBe(true)
  })

  test("substitutes the line", () => {
    const state = createMotions({ text: "alpha", cursor: 2 })

    state.motions.handleKey(key("s", { sequence: "S", shift: true }))

    expect(state.text()).toBe("")
    expect(state.cursor()).toBe(0)
    expect(state.insert()).toBe(true)
  })

  test("clears pending operators before substituting", () => {
    const lower = createMotions({ text: "alpha", cursor: 2 })

    lower.motions.handleKey(key("d"))
    lower.motions.handleKey(key("s"))
    expect(lower.text()).toBe("alha")

    const upper = createMotions({ text: "alpha", cursor: 2 })

    upper.motions.handleKey(key("d"))
    upper.motions.handleKey(key("s", { sequence: "S", shift: true }))
    expect(upper.text()).toBe("")
  })

  test("clears the line with dd", () => {
    const state = createMotions({ text: "alpha", cursor: 2 })

    state.motions.handleKey(key("d"))
    expect(state.text()).toBe("alpha")
    expect(state.cursor()).toBe(2)
    state.motions.handleKey(key("d"))
    expect(state.text()).toBe("")
    expect(state.cursor()).toBe(0)
  })

  test("clears pending operators explicitly", () => {
    const state = createMotions({ text: "alpha", cursor: 2 })

    state.motions.handleKey(key("d"))
    state.motions.clearPending()
    state.motions.handleKey(key("d"))
    expect(state.text()).toBe("alpha")
  })

  test("ignores modified keys and clears pending operators", () => {
    const events = [key("w", { ctrl: true }), key("w", { option: true }), key("w", { hyper: true })]

    for (const event of events) {
      const state = createMotions({ text: "alpha", cursor: 2 })
      state.motions.handleKey(key("d"))
      expect(state.motions.handleKey(event)).toBe(false)
      expect(event.defaultPrevented).toBe(false)
      expect(state.cursor()).toBe(2)
      state.motions.handleKey(key("d"))
      expect(state.text()).toBe("alpha")
    }
  })
})
