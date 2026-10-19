import { describe, expect, test } from "bun:test"
import { BoxRenderable, RGBA, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { drawShowbreak, showbreakRows } from "../src/component/prompt/showbreak"

describe("prompt showbreak", () => {
  test("finds visible wrapped continuation rows", () => {
    const info = { lineWraps: [0, 1, 2, 0, 1] }

    expect(showbreakRows(info, 0, 5)).toEqual([1, 2, 4])
    expect(showbreakRows(info, 2, 2)).toEqual([0])
  })

  test("draws the marker right-aligned in the prompt padding", () => {
    const calls: Array<{ text: string; x: number; y: number }> = []
    const buffer = {
      drawText(text: string, x: number, y: number) {
        calls.push({ text, x, y })
      },
    }
    const target = {
      x: 5,
      y: 10,
      height: 3,
      scrollY: 1,
      lineInfo: {
        lineStartCols: [0, 20, 40, 0],
        lineWidthCols: [20, 20, 20, 4],
        lineWidthColsMax: 60,
        lineSources: [0, 0, 0, 1],
        lineWraps: [0, 1, 2, 0],
      },
    }
    const color = RGBA.fromInts(255, 255, 255)

    drawShowbreak(buffer as any, target as any, true, color, color)

    expect(calls).toEqual([
      { text: "↪ ", x: 3, y: 10 },
      { text: "↪ ", x: 3, y: 11 },
    ])
  })

  test("renders in padding without changing prompt text", async () => {
    const setup = await createTestRenderer({ width: 24, height: 5, useThread: false })
    const box = new BoxRenderable(setup.renderer as any, { width: 22, height: 3, paddingLeft: 2 })
    const textarea = new TextareaRenderable(setup.renderer as any, { width: 20, height: 3, wrapMode: "word" })
    box.add(textarea)
    setup.renderer.root.add(box)
    textarea.setText("A".repeat(45))
    const original = textarea.plainText
    const render = textarea.render.bind(textarea)
    const color = RGBA.fromInts(128, 128, 128)
    let enabled = true
    textarea.render = (buffer, deltaTime) => {
      render(buffer, deltaTime)
      drawShowbreak(buffer, textarea, enabled, color, color)
    }

    try {
      await setup.renderOnce()
      const lines = setup.captureCharFrame().split("\n")
      expect(lines[0]?.startsWith("  A")).toBe(true)
      expect(lines[1]?.startsWith("↪ A")).toBe(true)
      expect(lines[2]?.startsWith("↪ A")).toBe(true)
      expect(textarea.plainText).toBe(original)

      enabled = false
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain("↪")

      enabled = true
      textarea.setText("short")
      await setup.renderOnce()
      expect(setup.captureCharFrame()).not.toContain("↪")
    } finally {
      setup.renderer.destroy()
    }
  })

  test("uses the textarea's visual scroll offset", async () => {
    const setup = await createTestRenderer({ width: 24, height: 4, useThread: false })
    const box = new BoxRenderable(setup.renderer as any, { width: 22, height: 2, paddingLeft: 2 })
    const textarea = new TextareaRenderable(setup.renderer as any, { width: 20, height: 2, wrapMode: "word" })
    box.add(textarea)
    setup.renderer.root.add(box)
    textarea.setText("A".repeat(60))
    textarea.cursorOffset = 59
    const render = textarea.render.bind(textarea)
    const color = RGBA.fromInts(128, 128, 128)
    textarea.render = (buffer, deltaTime) => {
      render(buffer, deltaTime)
      drawShowbreak(buffer, textarea, true, color, color)
    }

    try {
      await setup.renderOnce()
      const lines = setup.captureCharFrame().split("\n")
      expect(textarea.scrollY).toBe(1)
      expect(lines[0]?.startsWith("↪ A")).toBe(true)
      expect(lines[1]?.startsWith("↪ A")).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })

  test("does not draw when disabled or padding is unavailable", () => {
    let calls = 0
    const buffer = { drawText: () => calls++ }
    const target = {
      x: 5,
      y: 0,
      height: 1,
      scrollY: 0,
      lineInfo: { lineWraps: [1] },
    }
    const color = RGBA.fromInts(255, 255, 255)

    drawShowbreak(buffer as any, target as any, false, color, color)
    drawShowbreak(buffer as any, { ...target, x: 1 } as any, true, color, color)

    expect(calls).toBe(0)
  })
})
