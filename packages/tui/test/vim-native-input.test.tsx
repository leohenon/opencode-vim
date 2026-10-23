/** @jsxImportSource @opentui/solid */
import { test, expect } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createAppFixture } from "./fixture/app"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { Keymap } from "../src/context/keymap"
import { resolve } from "../src/config"

for (const key of ["ctrl-w", "ctrl-b", "backspace"]) {
  test(`normal-mode ${key} preserves composer text and cursor without a transcript`, async () => {
    await using app = await createAppFixture({
      config: { vim: true, vim_initial_mode: "normal", animations: false, tabs: { mode: "off" } },
    })
    await app.ready
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof TextareaRenderable)) throw new Error("Expected composer")
    app.mockInput.pressEscape()
    input.setText("one two three")
    input.cursorOffset = 7
    await app.renderOnce()
    if (key === "backspace") app.mockInput.pressKey("BACKSPACE")
    else app.mockInput.pressKey(key.slice(-1), { ctrl: true })
    await app.renderOnce()
    expect(input.plainText).toBe("one two three")
    expect(input.cursorOffset).toBe(7)
  })
}

for (const mode of ["insert", undefined]) {
  test(`native textarea editing and submit remain available in ${mode ?? "non-Vim"} inputs`, async () => {
    let input!: TextareaRenderable
    let submitted = 0
    function Harness() {
      Keymap.use().vim.set(mode)
      onMount(() => input.focus())
      return <textarea ref={(value) => (input = value)} initialValue="one two three" onSubmit={() => submitted++} />
    }
    const app = await testRender(
      () => (
        <Keymap.Provider config={resolve({ keybinds: { "input.submit": "super+return" } }, { terminalSuspend: true })}>
          <Harness />
        </Keymap.Provider>
      ),
      { width: 80, height: 24, kittyKeyboard: true },
    )
    try {
      input.cursorOffset = 7
      app.mockInput.pressKey("w", { ctrl: true })
      expect(input.plainText).toBe("one  three")
      input.setText("one two three")
      input.cursorOffset = 7
      app.mockInput.pressKey("b", { ctrl: true })
      expect(input.cursorOffset).toBe(6)
      app.mockInput.pressKey("BACKSPACE")
      expect(input.plainText).toBe("one to three")
      app.mockInput.pressEnter({ super: true })
      expect(submitted).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })
}
