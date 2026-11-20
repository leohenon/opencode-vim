import { describe, expect, test } from "bun:test"
import { vimCursorStyle } from "../src/component/vim/cursor-style"
import { resolve } from "../src/config"

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

describe("resolved Vim cursor", () => {
  const options = { terminalSuspend: true, environment: {} }

  test("stays unset without an explicit cursor so insert mode keeps its line cursor", () => {
    const config = resolve({}, options)
    expect(config.cursor).toEqual({ style: "block", blinking: true })
    expect(config.vim_cursor).toBeUndefined()
    expect(vimCursorStyle("insert", config.vim_cursor)).toEqual({ style: "line", blinking: true })
  })

  test("uses an explicit cursor in insert mode", () => {
    const config = resolve({ cursor: { blinking: false } }, options)
    expect(config.vim_cursor).toEqual({ style: "block", blinking: false })
    expect(vimCursorStyle("insert", config.vim_cursor)).toEqual({ style: "block", blinking: false })
  })
})
