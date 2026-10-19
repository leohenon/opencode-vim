import { describe, expect, test } from "bun:test"
import { vimCursorStyle } from "../src/component/vim/cursor-style"

const configured = { style: "default", blinking: false } as const

describe("vim cursor style", () => {
  test("preserves mode indicators in normal and replace modes", () => {
    expect(vimCursorStyle("normal", configured)).toEqual({ style: "block", blinking: false })
    expect(vimCursorStyle("replace", configured)).toEqual({ style: "underline", blinking: false })
  })

  test("uses configured cursor in insert and non-modal inputs", () => {
    expect(vimCursorStyle("insert", configured)).toEqual(configured)
    expect(vimCursorStyle(undefined, configured)).toEqual(configured)
  })

  test("falls back to a blinking line cursor", () => {
    expect(vimCursorStyle("insert")).toEqual({ style: "line", blinking: true })
    expect(vimCursorStyle(undefined)).toEqual({ style: "line", blinking: true })
  })
})
