/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createEffect, createSignal, Show } from "solid-js"
import { Keymap } from "../src/context/keymap"
import { InteractivityProvider } from "../src/context/interactivity"

const config = { keybinds: { get: () => [] } }

test("Vim publications suspend with their scope and disposal never clobbers a newer copy owner", async () => {
  const [enabled, setEnabled] = createSignal(true)
  const [mounted, setMounted] = createSignal(true)
  const [mode, setMode] = createSignal("normal")
  let global!: Keymap
  let form!: Keymap
  function Form() {
    form = Keymap.use()
    createEffect(() => form.vim.set(mode()))
    return null
  }
  function Harness() {
    global = Keymap.use()
    global.vim.set("insert")
    return (
      <InteractivityProvider enabled={enabled()}>
        <Show when={mounted()}>
          <Form />
        </Show>
      </InteractivityProvider>
    )
  }
  const app = await testRender(
    () => (
      <Keymap.Provider config={config}>
        <Harness />
      </Keymap.Provider>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
  try {
    expect(global.vim.current()).toBe("normal")
    setEnabled(false)
    expect(global.vim.current()).toBe("insert")
    setMode("insert")
    setMode("normal")
    expect(global.vim.current()).toBe("insert")
    setEnabled(true)
    expect(global.vim.current()).toBe("normal")
    global.vim.set("copy")
    expect(global.vim.current()).toBe("copy")
    setMounted(false)
    expect(global.vim.current()).toBe("copy")
  } finally {
    app.renderer.destroy()
  }
})
