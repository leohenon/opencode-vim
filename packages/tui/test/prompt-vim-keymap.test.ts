import { describe, expect, test } from "bun:test"
import { createTestKeymap } from "@opentui/keymap/testing"
import * as addons from "@opentui/keymap/addons/opentui"
import {
  OPENCODE_COPY_MODE,
  OPENCODE_COPY_MODE_ENTER_KEYS,
  OPENCODE_COPY_MODE_EXIT_KEYS,
  OPENCODE_COPY_MODE_TOGGLE_KEYS,
  VIM_WINDOW_TOKEN,
} from "../src/context/keymap"

const MODE_KEY = "opencode.mode"

function createModeLayer(keymap: ReturnType<typeof createTestKeymap>["keymap"]) {
  const offFields = keymap.registerLayerFields({
    mode(value, ctx) {
      ctx.require(MODE_KEY, value)
    },
  })
  keymap.setData(MODE_KEY, "base")
  return {
    set(mode: string) {
      keymap.setData(MODE_KEY, mode)
    },
    dispose: offFields,
  }
}

describe("prompt vim keymap layers", () => {
  test("the copy mode sequences are bound to the vim window token", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []
    addons.registerCommaBindings(testKeymap.keymap)
    testKeymap.keymap.registerToken({ name: VIM_WINDOW_TOKEN, key: "ctrl+w" })

    testKeymap.keymap.registerLayer({
      commands: [
        { name: "prompt.vim.copy.enter", run: () => void calls.push("enter") },
        { name: "prompt.vim.copy.toggle", run: () => void calls.push("toggle") },
        { name: "prompt.vim.copy.exit", run: () => void calls.push("exit") },
      ],
      bindings: [
        { key: OPENCODE_COPY_MODE_ENTER_KEYS, cmd: "prompt.vim.copy.enter" },
        { key: OPENCODE_COPY_MODE_TOGGLE_KEYS, cmd: "prompt.vim.copy.toggle" },
        { key: OPENCODE_COPY_MODE_EXIT_KEYS, cmd: "prompt.vim.copy.exit" },
      ],
    })

    testKeymap.host.press("w", { ctrl: true })
    expect(calls).toEqual([])
    testKeymap.host.press("k")
    expect(calls).toEqual(["enter"])

    testKeymap.host.press("w", { ctrl: true })
    testKeymap.host.press("w")
    expect(calls).toEqual(["enter", "toggle"])

    testKeymap.host.press("w", { ctrl: true })
    testKeymap.host.press("j", { ctrl: true })
    expect(calls).toEqual(["enter", "toggle", "exit"])
  })

  test("a copy mode layer only claims keys while the copy mode is active", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []
    const mode = createModeLayer(testKeymap.keymap)

    testKeymap.keymap.registerLayer({
      mode: OPENCODE_COPY_MODE,
      commands: [{ name: "prompt.vim.copy.scroll.ctrl-d", run: () => void calls.push("scroll") }],
      bindings: [{ key: "ctrl+d", cmd: "prompt.vim.copy.scroll.ctrl-d" }],
    })

    testKeymap.host.press("d", { ctrl: true })
    expect(calls).toEqual([])

    mode.set(OPENCODE_COPY_MODE)
    testKeymap.host.press("d", { ctrl: true })
    expect(calls).toEqual(["scroll"])

    mode.dispose()
  })
})
