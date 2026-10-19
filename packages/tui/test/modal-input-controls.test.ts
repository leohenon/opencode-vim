import { describe, expect, test } from "bun:test"
import { createModalInputControls, type ModalInputKeyEvent, type ModalInputMode } from "../src/component/vim/modal-input-controls"

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
  } as ModalInputKeyEvent
}

function createControls(input?: {
  mode?: ModalInputMode
  text?: string
  cursor?: number
  langmap?: Record<string, string>
  vimEscapeSequence?: string
}) {
  let mode = input?.mode ?? "normal"
  let text = input?.text ?? ""
  let cursor = input?.cursor ?? 0
  const moves: number[] = []
  const controls = createModalInputControls({
    mode: () => mode,
    setMode: (next) => (mode = next),
    move: (direction) => moves.push(direction),
    moveToStart: () => moves.push(-100),
    moveToEnd: () => moves.push(100),
    focus() {},
    text: () => text,
    cursor: () => cursor,
    setCursor: (next) => (cursor = next),
    setText: (next) => (text = next),
    langmap: () => input?.langmap,
    vimEscapeSequence: () => input?.vimEscapeSequence,
  })

  function insert(value: string) {
    text = text.slice(0, cursor) + value + text.slice(cursor)
    cursor += value.length
  }

  return { controls, moves, mode: () => mode, cursor: () => cursor, text: () => text, insert }
}

describe("modal input controls", () => {
  test("uses escape to enter normal mode and j/k to move selection", () => {
    const state = createControls({ mode: "insert" })

    const escape = key("escape")
    expect(state.controls.handleKey(escape)).toBe(true)
    expect(escape.defaultPrevented).toBe(true)
    expect(state.mode()).toBe("normal")

    state.controls.handleKey(key("j"))
    state.controls.handleKey(key("k"))
    expect(state.moves).toEqual([1, -1])
  })

  test("keeps modified bindings available for the outer keymap", () => {
    const state = createControls()
    const events = [key("n", { ctrl: true }), key("n", { option: true }), key("n", { hyper: true })]

    for (const event of events) {
      expect(state.controls.handleKey(event)).toBe(false)
      expect(event.defaultPrevented).toBe(false)
    }
  })

  test("clears pending text motions before entering insert mode", () => {
    const state = createControls({ text: "alpha", cursor: 2 })

    state.controls.handleKey(key("d"))
    state.controls.handleKey(key("i"))
    state.controls.handleKey(key("escape"))
    state.controls.handleKey(key("d"))

    expect(state.text()).toBe("alpha")
  })

  test("normalizes insert cursor when entering normal mode", () => {
    const state = createControls({ mode: "insert", text: "alpha", cursor: 5 })

    state.controls.handleKey(key("escape"))

    expect(state.mode()).toBe("normal")
    expect(state.cursor()).toBe(4)

    const middle = createControls({ mode: "insert", text: "alpha", cursor: 2 })

    middle.controls.handleKey(key("escape"))

    expect(middle.mode()).toBe("normal")
    expect(middle.cursor()).toBe(1)
  })

  test("uses configured escape sequence to enter normal mode", () => {
    const state = createControls({ mode: "insert", text: "alpha", cursor: 2, vimEscapeSequence: "jk" })

    const first = key("j")
    expect(state.controls.handleKey(first)).toBe(true)
    expect(first.defaultPrevented).toBe(true)
    expect(state.text()).toBe("alpha")

    const second = key("k")
    expect(state.controls.handleKey(second)).toBe(true)
    expect(second.defaultPrevented).toBe(true)
    expect(state.mode()).toBe("normal")
    expect(state.text()).toBe("alpha")
    expect(state.cursor()).toBe(1)
  })

  test("keeps text when escape sequence does not match", () => {
    const state = createControls({ mode: "insert", text: "alpha", cursor: 2, vimEscapeSequence: "jk" })

    const first = key("j")
    expect(state.controls.handleKey(first)).toBe(true)
    expect(first.defaultPrevented).toBe(true)
    expect(state.text()).toBe("alpha")
    expect(state.controls.handleKey(key("x"))).toBe(false)
    state.insert("x")

    expect(state.mode()).toBe("insert")
    expect(state.text()).toBe("aljxpha")
  })

  test("clears pending escape sequence before passing modified keys through", () => {
    const state = createControls({ mode: "insert", text: "alpha", cursor: 2, vimEscapeSequence: "jk" })

    state.controls.handleKey(key("j"))

    const modified = key("k", { ctrl: true })
    expect(state.controls.handleKey(modified)).toBe(false)
    expect(modified.defaultPrevented).toBe(false)

    expect(state.controls.handleKey(key("k"))).toBe(false)
    state.insert("k")

    expect(state.mode()).toBe("insert")
    expect(state.text()).toBe("aljkpha")
  })

  test("clears pending picker motions before passing ctrl bindings to the outer keymap", () => {
    const state = createControls()

    state.controls.handleKey(key("g"))
    state.controls.handleKey(key("n", { ctrl: true }))
    state.controls.handleKey(key("g"))
    expect(state.moves).toEqual([])
  })

  test("lets outer keymap commands clear pending motions", () => {
    const state = createControls({ text: "alpha", cursor: 2 })

    state.controls.handleKey(key("g"))
    state.controls.clearPending()
    state.controls.handleKey(key("g"))
    expect(state.moves).toEqual([])

    state.controls.handleKey(key("d"))
    state.controls.clearPending()
    state.controls.handleKey(key("d"))
    expect(state.text()).toBe("alpha")
  })

  test("supports gg and G jumps", () => {
    const state = createControls()

    state.controls.handleKey(key("g"))
    state.controls.handleKey(key("g"))
    state.controls.handleKey(key("g", { sequence: "G", shift: true }))
    expect(state.moves).toEqual([-100, 100])
  })

  test("applies langmap to normal-mode picker controls", () => {
    const state = createControls({ langmap: { о: "j", л: "k", п: "g" } })

    state.controls.handleKey(key("о", { sequence: "о" }))
    state.controls.handleKey(key("л", { sequence: "л" }))
    state.controls.handleKey(key("п", { sequence: "п" }))
    state.controls.handleKey(key("п", { sequence: "п" }))
    state.controls.handleKey(key("п", { sequence: "П", shift: true }))

    expect(state.moves).toEqual([1, -1, -100, 100])
  })

  test("supports basic cursor motions", () => {
    const state = createControls({ text: "alpha beta gamma", cursor: 6 })

    state.controls.handleKey(key("h"))
    expect(state.cursor()).toBe(5)
    state.controls.handleKey(key("l"))
    expect(state.cursor()).toBe(6)
    state.controls.handleKey(key("w"))
    expect(state.cursor()).toBe(11)
    state.controls.handleKey(key("b"))
    expect(state.cursor()).toBe(6)
    state.controls.handleKey(key("e"))
    expect(state.cursor()).toBe(9)
    state.controls.handleKey(key("0"))
    expect(state.cursor()).toBe(0)
    state.controls.handleKey(key("4", { sequence: "$", shift: true }))
    expect(state.cursor()).toBe(15)
  })

  test("supports s and S substitute motions", () => {
    const substitute = createControls({ text: "alpha", cursor: 2 })

    substitute.controls.handleKey(key("s"))
    expect(substitute.text()).toBe("alha")
    expect(substitute.cursor()).toBe(2)
    expect(substitute.mode()).toBe("insert")

    const line = createControls({ text: "alpha", cursor: 2 })
    line.controls.handleKey(key("s", { sequence: "S", shift: true }))
    expect(line.text()).toBe("")
    expect(line.cursor()).toBe(0)
    expect(line.mode()).toBe("insert")
  })

  test("supports i and a insert motions", () => {
    const insert = createControls({ text: "alpha", cursor: 2 })

    insert.controls.handleKey(key("i"))
    expect(insert.cursor()).toBe(2)
    expect(insert.mode()).toBe("insert")

    const append = createControls({ text: "alpha", cursor: 2 })
    append.controls.handleKey(key("a"))
    expect(append.cursor()).toBe(3)
    expect(append.mode()).toBe("insert")
  })

  test("supports I and A insert motions", () => {
    const state = createControls({ text: "alpha", cursor: 2 })

    state.controls.handleKey(key("i", { sequence: "I", shift: true }))
    expect(state.cursor()).toBe(0)
    expect(state.mode()).toBe("insert")

    const next = createControls({ text: "alpha", cursor: 2 })
    next.controls.handleKey(key("a", { sequence: "A", shift: true }))
    expect(next.cursor()).toBe(5)
    expect(next.mode()).toBe("insert")
  })
})
