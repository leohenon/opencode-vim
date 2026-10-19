import { describe, expect, test } from "bun:test"
import { createTestKeymap } from "@opentui/keymap/testing"
import * as addons from "@opentui/keymap/addons/opentui"
import { createBindingLookup } from "@opentui/keymap/extras"
import {
  OPENCODE_COPY_MODE,
  OPENCODE_COPY_MODE_ENTER_KEYS,
  OPENCODE_COPY_MODE_TOGGLE_KEYS,
  OPENCODE_VIM_MODE_KEY,
  VIM_WINDOW_TOKEN,
  registerOpencodeLeader,
} from "../src/keymap"
import { TuiKeybind } from "../src/config/keybind"

const MODE_KEY = "test.mode"
const QUESTION_MODE = "question"

function createResolvedKeymapConfig(input: TuiKeybind.KeybindOverrides = {}) {
  const keybinds = TuiKeybind.parse(input)
  return {
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: 2000,
  }
}

function createModeStack(keymap: ReturnType<typeof createTestKeymap>["keymap"]) {
  const offFields = keymap.registerLayerFields({
    mode(value, ctx) {
      ctx.require(MODE_KEY, value)
    },
  })
  const stack: string[] = []
  const update = () => keymap.setData(MODE_KEY, stack.at(-1) ?? "base")

  update()

  return {
    current: () => stack.at(-1) ?? "base",
    push(mode: string) {
      stack.push(mode)
      update()
      return () => {
        const index = stack.lastIndexOf(mode)
        if (index !== -1) stack.splice(index, 1)
        update()
      }
    },
    dispose: offFields,
  }
}

describe("opencode keymap", () => {
  test("vim window token sequences can override exact ctrl+w input bindings by priority", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []

    testKeymap.keymap.registerToken({ name: VIM_WINDOW_TOKEN, key: "ctrl+w" })
    testKeymap.keymap.registerLayer({
      bindings: [{ key: "ctrl+w", cmd: () => void calls.push("delete-word-backward") }],
    })
    testKeymap.keymap.registerLayer({
      priority: 100,
      bindings: [{ key: `<${VIM_WINDOW_TOKEN}>k`, cmd: () => void calls.push("copy-mode") }],
    })

    testKeymap.host.press("w", { ctrl: true })
    expect(calls).toEqual([])
    expect(testKeymap.keymap.getPendingSequence().map((item) => item.display)).toEqual([`<${VIM_WINDOW_TOKEN}>`])

    testKeymap.host.press("k")
    expect(calls).toEqual(["copy-mode"])
  })

  test("vim window token supports holding ctrl for the second w", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []

    testKeymap.keymap.registerToken({ name: VIM_WINDOW_TOKEN, key: "ctrl+w" })
    testKeymap.keymap.registerLayer({
      bindings: [{ key: "ctrl+w", cmd: () => void calls.push("delete-word-backward") }],
    })
    testKeymap.keymap.registerLayer({
      priority: 100,
      bindings: [{ key: `<${VIM_WINDOW_TOKEN}><${VIM_WINDOW_TOKEN}>`, cmd: () => void calls.push("toggle-copy") }],
    })

    testKeymap.host.press("w", { ctrl: true })
    testKeymap.host.press("w", { ctrl: true })

    expect(calls).toEqual(["toggle-copy"])
    expect(testKeymap.keymap.getPendingSequence()).toEqual([])
  })

  test("vim window token supports holding ctrl for j/k navigation bindings", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []

    addons.registerCommaBindings(testKeymap.keymap)
    testKeymap.keymap.registerToken({ name: VIM_WINDOW_TOKEN, key: "ctrl+w" })
    testKeymap.keymap.registerLayer({
      priority: 100,
      bindings: [
        { key: `<${VIM_WINDOW_TOKEN}>j,<${VIM_WINDOW_TOKEN}>ctrl+j`, cmd: () => void calls.push("down") },
        { key: `<${VIM_WINDOW_TOKEN}>k,<${VIM_WINDOW_TOKEN}>ctrl+k`, cmd: () => void calls.push("up") },
      ],
    })

    testKeymap.host.press("w", { ctrl: true })
    testKeymap.host.press("j", { ctrl: true })
    testKeymap.host.press("w", { ctrl: true })
    testKeymap.host.press("k", { ctrl: true })

    expect(calls).toEqual(["down", "up"])
    expect(testKeymap.keymap.getPendingSequence()).toEqual([])
  })

  test("vim window token supports comma-separated held ctrl+w binding", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []

    addons.registerCommaBindings(testKeymap.keymap)
    testKeymap.keymap.registerToken({ name: VIM_WINDOW_TOKEN, key: "ctrl+w" })
    testKeymap.keymap.registerLayer({
      priority: 100,
      bindings: [
        {
          key: `<${VIM_WINDOW_TOKEN}>w,<${VIM_WINDOW_TOKEN}><${VIM_WINDOW_TOKEN}>,<${VIM_WINDOW_TOKEN}>ctrl+w`,
          cmd: () => void calls.push("toggle-copy"),
        },
      ],
    })

    testKeymap.host.press("w", { ctrl: true })
    testKeymap.host.press("w", { ctrl: true })

    expect(calls).toEqual(["toggle-copy"])
    expect(testKeymap.keymap.getPendingSequence()).toEqual([])
  })

  test("default leader still starts leader sequences", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []
    const config = createResolvedKeymapConfig({ session_new: "<leader>n" })
    const offLeader = registerOpencodeLeader(testKeymap.keymap, config)

    testKeymap.keymap.registerLayer({
      bindings: [{ key: "<leader>n", cmd: "session.new" }],
      commands: [{ name: "session.new", run: () => void calls.push("new") }],
    })

    testKeymap.host.press("x", { ctrl: true })
    testKeymap.host.press("n")

    expect(calls).toEqual(["new"])
    offLeader()
  })

  test("vim normal leader only starts leader sequences in normal mode", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []
    const config = createResolvedKeymapConfig({
      "vim.normal": { leader: "space" },
      session_new: "<leader>n",
    })
    const offLeader = registerOpencodeLeader(testKeymap.keymap, config)

    testKeymap.keymap.registerLayer({
      bindings: [{ key: "<leader>n", cmd: "session.new" }],
      commands: [{ name: "session.new", run: () => void calls.push("new") }],
    })

    testKeymap.keymap.setData(OPENCODE_VIM_MODE_KEY, "insert")
    testKeymap.host.press("space")
    testKeymap.host.press("n")
    testKeymap.host.press("x", { ctrl: true })
    testKeymap.host.press("n")
    testKeymap.keymap.setData(OPENCODE_VIM_MODE_KEY, "normal")
    testKeymap.host.press("space")
    testKeymap.host.press("n")

    expect(calls).toEqual(["new"])
    offLeader()
  })

  test("vim normal leader takes priority over exact leader-key bindings", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []
    const config = createResolvedKeymapConfig({
      "vim.normal": { leader: "space" },
      session_new: "<leader>n",
    })
    const offLeader = registerOpencodeLeader(testKeymap.keymap, config)

    testKeymap.keymap.registerLayer({
      bindings: [
        { key: "space", cmd: () => void calls.push("space") },
        { key: "<leader>n", cmd: "session.new" },
      ],
      commands: [{ name: "session.new", run: () => void calls.push("new") }],
    })

    testKeymap.keymap.setData(OPENCODE_VIM_MODE_KEY, "insert")
    testKeymap.host.press("space")
    testKeymap.keymap.setData(OPENCODE_VIM_MODE_KEY, "normal")
    testKeymap.host.press("space")
    testKeymap.host.press("n")

    expect(calls).toEqual(["space", "new"])
    offLeader()
  })

  test("explicit global leader still works with vim normal leader", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []
    const config = createResolvedKeymapConfig({
      leader: "ctrl+x",
      "vim.normal": { leader: "space" },
      session_new: "<leader>n",
    })
    const offLeader = registerOpencodeLeader(testKeymap.keymap, config)

    testKeymap.keymap.registerLayer({
      bindings: [{ key: "<leader>n", cmd: "session.new" }],
      commands: [{ name: "session.new", run: () => void calls.push("new") }],
    })

    testKeymap.keymap.setData(OPENCODE_VIM_MODE_KEY, "insert")
    testKeymap.host.press("x", { ctrl: true })
    testKeymap.host.press("n")
    testKeymap.host.press("space")
    testKeymap.host.press("n")
    testKeymap.keymap.setData(OPENCODE_VIM_MODE_KEY, "normal")
    testKeymap.host.press("space")
    testKeymap.host.press("n")

    expect(calls).toEqual(["new", "new"])
    offLeader()
  })

  test("vim mode-scoped bindings only run in matching vim mode", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []
    const offFields = testKeymap.keymap.registerBindingFields({
      vimMode(value, ctx) {
        ctx.require(OPENCODE_VIM_MODE_KEY, value)
      },
    })

    testKeymap.keymap.registerLayer({
      bindings: [{ key: "j", vimMode: "normal", cmd: () => void calls.push("normal:j") }],
    })

    testKeymap.keymap.setData(OPENCODE_VIM_MODE_KEY, "insert")
    testKeymap.host.press("j")
    testKeymap.keymap.setData(OPENCODE_VIM_MODE_KEY, "normal")
    testKeymap.host.press("j")

    expect(calls).toEqual(["normal:j"])
    offFields()
  })

  test("copy mode ctrl scroll bindings can claim keys before global bindings", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    const calls: string[] = []
    const keys = ["ctrl+d", "ctrl+u", "ctrl+f", "ctrl+b", "ctrl+e", "ctrl+y"]

    testKeymap.keymap.registerLayer({
      bindings: keys.map((key) => ({ key, cmd: () => void calls.push(`global:${key}`) })),
    })
    testKeymap.keymap.registerLayer({
      priority: 100,
      bindings: keys.map((key) => ({ key, cmd: () => void calls.push(`copy:${key}`) })),
    })

    for (const key of ["d", "u", "f", "b", "e", "y"]) {
      testKeymap.host.press(key, { ctrl: true })
    }

    expect(calls).toEqual(keys.map((key) => `copy:${key}`))
  })

  test("question copy mode enters with vim-window keys and returns to question navigation", () => {
    const testKeymap = createTestKeymap({ defaultKeys: true })
    addons.registerCommaBindings(testKeymap.keymap)
    testKeymap.keymap.registerToken({ name: VIM_WINDOW_TOKEN, key: "ctrl+w" })
    const modeStack = createModeStack(testKeymap.keymap)
    const calls: string[] = []
    let popCopyMode: (() => void) | undefined

    testKeymap.keymap.registerLayer({
      commands: [
        {
          name: "session.copy_mode",
          run() {
            if (modeStack.current() === OPENCODE_COPY_MODE) {
              popCopyMode?.()
              popCopyMode = undefined
              return
            }
            popCopyMode = modeStack.push(OPENCODE_COPY_MODE)
            calls.push("copy:enter")
          },
        },
      ],
    })
    testKeymap.keymap.registerLayer({
      mode: QUESTION_MODE,
      bindings: [
        { key: "ctrl+v", cmd: () => testKeymap.keymap.dispatchCommand("session.copy_mode") },
        { key: OPENCODE_COPY_MODE_ENTER_KEYS, cmd: () => testKeymap.keymap.dispatchCommand("session.copy_mode") },
        { key: OPENCODE_COPY_MODE_TOGGLE_KEYS, cmd: () => testKeymap.keymap.dispatchCommand("session.copy_mode") },
        { key: "h", cmd: () => void calls.push("question:previous") },
        { key: "l", cmd: () => void calls.push("question:next") },
      ],
    })
    testKeymap.keymap.registerLayer({
      mode: OPENCODE_COPY_MODE,
      bindings: [
        { key: "j", cmd: () => void calls.push("copy:navigate") },
        { key: "y", cmd: () => void calls.push("copy:yank") },
        {
          key: "q,escape",
          cmd: () => {
            calls.push("copy:exit")
            popCopyMode?.()
            popCopyMode = undefined
          },
        },
      ],
    })

    const popQuestion = modeStack.push(QUESTION_MODE)
    testKeymap.host.press("w", { ctrl: true })
    expect(calls).toEqual([])
    expect(testKeymap.keymap.getPendingSequence().map((item) => item.display)).toEqual([`<${VIM_WINDOW_TOKEN}>`])
    testKeymap.host.press("k")
    testKeymap.host.press("j")
    testKeymap.host.press("y")
    testKeymap.host.press("q")
    testKeymap.host.press("h")
    testKeymap.host.press("w", { ctrl: true })
    expect(testKeymap.keymap.getPendingSequence().map((item) => item.display)).toEqual([`<${VIM_WINDOW_TOKEN}>`])
    testKeymap.host.press("w")
    testKeymap.host.press("q")
    testKeymap.host.press("l")

    expect(calls).toEqual([
      "copy:enter",
      "copy:navigate",
      "copy:yank",
      "copy:exit",
      "question:previous",
      "copy:enter",
      "copy:exit",
      "question:next",
    ])
    expect(modeStack.current()).toBe(QUESTION_MODE)

    popQuestion()
    modeStack.dispose()
  })
})
