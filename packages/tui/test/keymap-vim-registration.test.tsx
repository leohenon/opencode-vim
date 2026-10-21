/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup, Show } from "solid-js"
import { Keymap } from "../src/context/keymap"
import { InteractivityProvider } from "../src/context/interactivity"

const config = { keybinds: { get: () => [] } }

test("reactive Vim registrations preserve ownership across forms, dialogs and newer copy scopes", async () => {
  const [active, setActive] = createSignal(true)
  const [interactive, setInteractive] = createSignal(true)
  const [mounted, setMounted] = createSignal(true)
  const [mode, setMode] = createSignal<string | undefined>("normal")
  let keymap!: Keymap
  function Form() {
    onCleanup(Keymap.use().vim.register(mode, active))
    return null
  }
  function Harness() {
    keymap = Keymap.use()
    onCleanup(keymap.vim.register(() => "insert"))
    return (
      <InteractivityProvider enabled={interactive()}>
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
    expect(keymap.vim.current()).toBe("normal")
    setActive(false)
    expect(keymap.vim.current()).toBe("insert")
    setMode("insert")
    setMode("normal")
    expect(keymap.vim.current()).toBe("insert")
    setActive(true)
    expect(keymap.vim.current()).toBe("normal")
    setInteractive(false)
    expect(keymap.vim.current()).toBe("insert")
    setInteractive(true)
    setMode(undefined)
    expect(keymap.vim.current()).toBeUndefined()
    setMode("normal")
    const closeDialog = keymap.vim.register(() => "insert")
    expect(keymap.vim.current()).toBe("insert")
    keymap.vim.set("copy")
    setMode("insert")
    setMode("normal")
    closeDialog()
    closeDialog()
    expect(keymap.vim.current()).toBe("copy")
    setMounted(false)
    expect(keymap.vim.current()).toBe("copy")
    keymap.vim.set(undefined)
    expect(keymap.vim.current()).toBe("insert")
  } finally {
    app.renderer.destroy()
  }
})
