import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { useVimIndicator } from "../../../src/component/vim/vim-indicator"
import { createVimState, type VimMode, type VimPending } from "../../../src/component/vim/vim-state"

function label(opts?: {
  enabled?: boolean
  active?: boolean
  mode?: VimMode
  pending?: VimPending
  pendingDisplay?: string
  count?: string
  copy?: undefined | "char" | "line" | "block"
}) {
  return createRoot((dispose) => {
    const [enabled] = createSignal(opts?.enabled ?? true)
    const [active] = createSignal(opts?.active ?? true)
    const [copy] = createSignal(opts?.copy)
    const state = createVimState({
      enabled,
      initial: () => opts?.mode ?? "normal",
    })

    if (opts?.mode && opts.mode !== "normal") state.setMode(opts.mode)
    if (opts?.pending) state.setPending(opts.pending, opts.pendingDisplay)
    opts?.count?.split("").forEach((digit) => state.appendCountDigit(digit))

    const result = useVimIndicator({
      enabled,
      active,
      state,
      copyVisual: copy,
    })()

    dispose()
    return result
  })
}

describe("vim indicator", () => {
  test("shows pending key as an unfinished command", () => {
    expect(label({ pending: "d" })).toBe("d..")
    expect(label({ pending: "y" })).toBe("y..")
  })

  test("pending key takes priority over copy label", () => {
    expect(label({ mode: "copy", pending: "z" })).toBe("z..")
  })

  test("shows pending display when present", () => {
    expect(label({ pending: "f", pendingDisplay: "df" })).toBe("df..")
  })

  test("shows ctrl-w pending display", () => {
    expect(label({ pending: "w", pendingDisplay: "^W" })).toBe("^W..")
  })

  test("shows count when present", () => {
    expect(label({ count: "12" })).toBe("12")
  })

  test("shows copy label when no key is pending", () => {
    expect(label({ mode: "copy" })).toBe("-- COPY --")
  })

  test("shows visual labels in copy mode", () => {
    expect(label({ mode: "copy", copy: "char" })).toBe("-- VISUAL --")
    expect(label({ mode: "copy", copy: "line" })).toBe("-- VISUAL LINE --")
    expect(label({ mode: "copy", copy: "block" })).toBe("-- VISUAL BLOCK --")
  })
})
