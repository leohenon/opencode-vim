import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createRoot, createSignal } from "solid-js"
import { createCopyMode, type CopyTarget } from "../../../src/routes/session/copy-mode"

function fixture(input: { text: string; lines?: number[]; starts?: number[]; widths?: number[] }) {
  const sources = input.lines ?? input.text.split("\n").map((_, index) => index)
  const text = {
    plainText: input.text,
    lineInfo: {
      lineSources: sources,
      lineStartCols: input.starts ?? sources.map(() => 0),
      lineWidthCols: input.widths ?? input.text.split("\n").map((line) => Bun.stringWidth(line)),
    },
    getLayout: () => ({ left: 0, top: 0 }),
    getChildren: () => [],
  }
  const height = sources.length
  const child = {
    id: "copy-row",
    y: 0,
    height,
    getChildren: () => [text],
  }
  let scrollTop = 0
  const scroll = {
    y: 0,
    width: 80,
    height: 20,
    scrollHeight: height,
    get scrollTop() {
      return scrollTop
    },
    isDestroyed: false,
    getChildren: () => [child],
    scrollBy(amount: number) {
      scrollTop += amount
    },
    scrollTo(top: number) {
      scrollTop = top
    },
  } as unknown as ScrollBoxRenderable
  const target: CopyTarget = { key: "row", id: "copy-row", role: "assistant", kind: "text", col: 0 }
  return { scroll, target }
}

test.each([
  ["char", "alpha\nbe"],
  ["line", "alpha\nbeta"],
  ["block", "al\nbe"],
] as const)("%s selection snapshots are detached and have no copy side effects", (mode, text) => {
  const view = fixture({ text: "alpha\nbeta" })
  Object.assign(view.target, { messageID: "message", part: "part" })
  createRoot((dispose) => {
    let writes = 0
    let exits = 0
    const copy = createCopyMode({
      scroll: () => view.scroll,
      targets: () => [view.target],
      session: () => "session",
      toBottom: () => exits++,
      write: async () => {
        writes++
      },
    })
    try {
      expect(copy.prompt.selection()).toBeUndefined()
      copy.prompt.enter()
      copy.prompt.jump("top")
      expect(copy.prompt.selection()).toBeUndefined()
      copy.prompt.visual(mode)
      copy.prompt.move("right")
      copy.prompt.move("down")
      const before = { col: copy.prompt.col(), highlights: copy.highlights(), scroll: view.scroll.scrollTop }
      const snapshot = copy.prompt.selection()!
      expect(snapshot).toEqual({
        sessionID: "session",
        text,
        mode,
        references: [{ messageID: "message", partID: "part", role: "assistant" }],
      })
      expect(copy.prompt.selection()).not.toBe(snapshot)
      expect(copy.prompt.selection()!.references[0]).not.toBe(snapshot.references[0])
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.references)).toBe(true)
      expect(Object.isFrozen(snapshot.references[0])).toBe(true)
      expect({ col: copy.prompt.col(), highlights: copy.highlights(), scroll: view.scroll.scrollTop }).toEqual(before)
      expect(copy.prompt.active()).toBe(true)
      expect(copy.prompt.isVisual()).toBe(true)
      expect(writes).toBe(0)
      expect(exits).toBe(0)
      view.target.messageID = "changed"
      copy.prompt.move("right")
      expect(snapshot.references[0].messageID).toBe("message")
      expect(snapshot.text).toBe(text)
      copy.prompt.exitVisual()
      expect(copy.prompt.selection()).toBeUndefined()
      copy.prompt.exit()
      expect(copy.prompt.selection()).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

test("blank visual selections have no snapshot", () => {
  const view = fixture({ text: "   " })
  createRoot((dispose) => {
    const copy = createCopyMode({
      scroll: () => view.scroll,
      targets: () => [view.target],
      session: () => "session",
      toBottom() {},
      write: async () => {},
    })
    try {
      copy.prompt.enter()
      copy.prompt.visual("line")
      expect(copy.prompt.selection()).toBeUndefined()
    } finally {
      dispose()
    }
  })
})

test("line visual yank copies V2 render rows", () => {
  const view = fixture({ text: "alpha\nbeta" })
  createRoot((dispose) => {
    const copy = createCopyMode({
      scroll: () => view.scroll,
      targets: () => [view.target],
      session: () => "session",
      toBottom: () => undefined,
      write: async () => undefined,
    })
    copy.prompt.enter()
    copy.prompt.jump("top")
    copy.prompt.visual("line")
    copy.prompt.move("down")
    expect(copy.prompt.yank()).toEqual({ text: "alpha\nbeta", linewise: false })
    dispose()
  })
})

test("soft-wrapped display rows remain one logical copied line", () => {
  const view = fixture({ text: "helloworld", lines: [0, 0], starts: [0, 5], widths: [5, 5] })
  createRoot((dispose) => {
    const copy = createCopyMode({
      scroll: () => view.scroll,
      targets: () => [view.target],
      session: () => "session",
      toBottom: () => undefined,
      write: async () => undefined,
    })
    copy.prompt.enter()
    copy.prompt.jump("top")
    copy.prompt.visual("line")
    copy.prompt.move("down")
    expect(copy.prompt.yank()).toEqual({ text: "helloworld", linewise: false })
    dispose()
  })
})

test("Unicode cell navigation, extraction, search, and highlights keep graphemes intact", () => {
  const view = fixture({ text: "A👨‍👩‍👧‍👦界éZ" })
  createRoot((dispose) => {
    const copy = createCopyMode({
      scroll: () => view.scroll,
      targets: () => [view.target],
      session: () => "session",
      toBottom: () => undefined,
      write: async () => undefined,
    })
    copy.prompt.enter()
    copy.prompt.jump("top")
    copy.prompt.move("right")
    expect(copy.prompt.col()).toBe(1)
    copy.prompt.visual("char")
    copy.prompt.move("right")
    expect(copy.prompt.col()).toBe(3)
    expect(copy.prompt.yank()).toEqual({ text: "👨‍👩‍👧‍👦界", linewise: false })
    expect(copy.prompt.selection()?.text).toBe("👨‍👩‍👧‍👦界")

    copy.prompt.exitVisual()
    copy.prompt.searchStart("forward")
    copy.prompt.searchAppend("界")
    copy.prompt.searchAppend("é")
    expect(copy.prompt.searchSubmit()).toBe(true)
    expect(copy.prompt.col()).toBe(3)
    expect(copy.highlights().get(view.target.id)).toContainEqual({
      line: 0,
      left: 3,
      right: 5,
      text: "界é",
      kind: "search",
      current: true,
    })
    dispose()
  })
})

test("registered V2 tool output toggles from copy mode", () => {
  const view = fixture({ text: "$ command output" })
  view.target.kind = "tool"
  createRoot((dispose) => {
    let toggled = 0
    const copy = createCopyMode({
      scroll: () => view.scroll,
      targets: () => [view.target],
      session: () => "session",
      toBottom: () => undefined,
      canToggle: (id) => id === view.target.id,
      toggleCollapsed: () => {
        toggled++
        return true
      },
      write: async () => undefined,
    })
    copy.prompt.enter()
    copy.prompt.jump("top")
    expect(copy.prompt.toggleCollapsed()).toBe(true)
    expect(toggled).toBe(1)
    dispose()
  })
})

test("activates a non-empty subagent row", () => {
  const view = fixture({ text: "Explore subagent" })
  view.target.kind = "tool"
  view.target.tool = "subagent"
  createRoot((dispose) => {
    let activated: string | undefined
    const copy = createCopyMode({
      scroll: () => view.scroll,
      targets: () => [view.target],
      session: () => "session",
      toBottom: () => undefined,
      activate: (row) => {
        activated = row.tool
        return true
      },
      write: async () => undefined,
    })
    copy.prompt.enter()
    expect(copy.prompt.activate()).toBe(true)
    expect(activated).toBe("subagent")
    dispose()
  })
})

test("copy search uses rendered transcript text and wraps", () => {
  const view = fixture({ text: "alpha\nbeta alpha" })
  createRoot((dispose) => {
    const copy = createCopyMode({
      scroll: () => view.scroll,
      targets: () => [view.target],
      session: () => "session",
      toBottom: () => undefined,
      write: async () => undefined,
    })
    copy.prompt.enter()
    copy.prompt.jump("top")
    copy.prompt.searchStart("forward")
    for (const char of "alpha") copy.prompt.searchAppend(char)
    expect(copy.prompt.searchSubmit()).toBe(true)
    expect(copy.prompt.searchMatchCount()).toBe(2)
    expect(copy.prompt.searchNext()).toBe(true)
    dispose()
  })
})

function tableFixture(cells: string[][]) {
  const rowOffsets = cells.reduce<number[]>((offsets) => [...offsets, (offsets.at(-1) ?? 0) + 2], [0])
  const height = (rowOffsets.at(-1) ?? 0) + 1
  const table = {
    getLayout: () => ({ top: 0, left: 7 }), // Physical content offset, including the four-column gutter.
    _cells: cells.map((row, rowIndex) =>
      row.map((text, columnIndex) => ({
        textBufferView: {
          getPlainText: () => cells[rowIndex]![columnIndex]!,
          lineInfo: {
            lineSources: [0],
            lineStartCols: [0],
            lineWidthCols: [Bun.stringWidth(text)],
          },
        },
      })),
    ),
    _layout: {
      rowOffsets,
      rowHeights: cells.map(() => 1),
      columnOffsets: [0, 8],
      columnWidths: [7, 7],
      tableWidth: 23,
    },
    _cellPaddingY: 0,
    ensureLayoutReady() {},
    getSelectedText: () => cells.map((row) => row.join("\t")).join("\n"),
    getChildren: () => [],
  }
  const child = {
    id: "copy-row",
    y: 0,
    height,
    gutter: { calculateWidth: () => 4 },
    getChildren: () => [table],
  }
  const scroll = {
    y: 0,
    width: 120,
    height: 20,
    scrollHeight: height,
    getChildren: () => [child],
    scrollBy() {},
    scrollTo() {},
  } as unknown as ScrollBoxRenderable
  const target: CopyTarget = { key: "table", id: "copy-row", role: "assistant", kind: "text", col: 3 }
  const copy = createCopyMode({
    scroll: () => scroll,
    targets: () => [target],
    session: () => "session",
    toBottom: () => undefined,
    write: async () => undefined,
  })
  copy.prompt.enter()
  copy.prompt.jump("top")
  return copy
}

test("table rows copy as tab-separated cells without borders", () => {
  createRoot((dispose) => {
    const copy = tableFixture([
      ["Name", "Value"],
      ["Alpha", "Beta"],
    ])
    copy.prompt.visual("line")
    for (let index = 0; index < 4; index++) copy.prompt.move("down")
    expect(copy.prompt.yank()).toEqual({ text: "Name\tValue\nAlpha\tBeta", linewise: false })
    dispose()
  })
})

test("table character and block selections use rendered cell geometry", () => {
  createRoot((dispose) => {
    const character = tableFixture([["Name", "Value"]])
    character.prompt.move("down")
    character.prompt.setCol(16)
    character.prompt.visual("char")
    for (let index = 0; index < 4; index++) character.prompt.move("right")
    expect(character.prompt.yank()).toEqual({ text: "Value", linewise: false })
    expect(character.prompt.selection()?.text).toBe("Value")

    const block = tableFixture([
      ["Name", "Value"],
      ["Alpha", "Beta"],
    ])
    block.prompt.move("down")
    block.prompt.setCol(7)
    block.prompt.visual("block")
    for (let index = 0; index < 4; index++) block.prompt.move("right")
    block.prompt.move("down")
    block.prompt.move("down")
    expect(block.prompt.yank()).toEqual({ text: " Name\n Alph", linewise: false })
    dispose()
  })
})

test("prepares paginated virtual rows and follows streaming text", () => {
  createRoot((dispose) => {
    const all = Array.from({ length: 100 }, (_, index) => {
      const text = {
        plainText: `line ${index}`,
        lineInfo: { lineSources: [0], lineStartCols: [0], lineWidthCols: [7] },
        getLayout: () => ({ left: 0, top: 0 }),
        getChildren: () => [],
      }
      return {
        target: {
          key: `row-${index}`,
          id: `copy-row-${index}`,
          role: "assistant" as const,
          kind: "text" as const,
          col: 0,
        },
        child: { id: `copy-row-${index}`, y: index, height: 1, getChildren: () => [text] },
        text,
      }
    })
    const [targets, setTargets] = createSignal(all.slice(60).map((item) => item.target))
    const children = all.slice(60).map((item) => item.child)
    const [session] = createSignal("one")
    let prepared = 0
    const scroll = {
      y: 60,
      width: 80,
      height: 20,
      scrollHeight: 100,
      getChildren: () => children,
      scrollBy() {},
      scrollTo() {},
    } as unknown as ScrollBoxRenderable
    const copy = createCopyMode({
      scroll: () => scroll,
      targets,
      session,
      toBottom: () => undefined,
      prepare(continuation) {
        prepared++
        children.splice(0, children.length, ...all.map((item) => item.child))
        setTargets(all.map((item) => item.target))
        continuation()
      },
      write: async () => undefined,
    })

    copy.prompt.enter()
    expect(prepared).toBe(1)
    copy.prompt.jump("bottom")
    expect(copy.row()?.id).toBe("copy-row-99")
    all[99]!.text.plainText = "streamed final text"
    all[99]!.text.lineInfo.lineWidthCols = [19]
    expect(copy.prompt.yankLine()).toEqual({ text: "streamed final text", linewise: false })
    dispose()
  })
})

test("block end-of-line selection retains virtual anchor columns when endpoints swap", () => {
  const view = fixture({ text: "0123456789\nabc" })
  createRoot((dispose) => {
    const copy = createCopyMode({
      scroll: () => view.scroll,
      targets: () => [view.target],
      session: () => "block",
      toBottom() {},
      write: async () => {},
    })
    try {
      copy.prompt.enter()
      copy.prompt.jump("top")
      copy.prompt.setCol(8)
      copy.prompt.visual("block")
      copy.prompt.move("down")
      copy.prompt.setStick("end")
      expect(copy.prompt.yank()?.text).toBe("89\n")
      copy.prompt.copyToggleVisualEnd()
      expect(copy.prompt.yank()?.text).toBe("89\n")
    } finally {
      dispose()
    }
  })
})

test("same-size table cell updates refresh cursor paint and selection text together", () => {
  createRoot((dispose) => {
    const cells = [["foo", "value"]]
    const copy = tableFixture(cells)
    try {
      copy.prompt.move("down")
      copy.prompt.setCol(8)
      copy.prompt.visual("char")
      copy.prompt.move("right")
      copy.prompt.move("right")
      copy.refresh()
      expect(copy.prompt.yank()?.text).toBe("foo")
      expect(copy.cursorText()).toBe("o")
      cells[0]![0] = "bar"
      copy.refresh()
      expect(copy.prompt.yank()?.text).toBe("bar")
      expect(copy.cursorText()).toBe("r")
    } finally {
      dispose()
    }
  })
})
