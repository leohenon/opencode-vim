/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { resolve } from "../src/config"
import { Keymap } from "../src/context/keymap"

function render(input: Parameters<typeof resolve>[0], exactSpace = false) {
  const calls: string[] = []
  let keymap!: Keymap

  function Harness() {
    keymap = Keymap.use()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        { id: "input.move.down", run: () => void calls.push("down") },
        { id: "session.new", run: () => void calls.push("new") },
        { id: "session.copy_mode", run: () => void calls.push("copy") },
        { id: "prompt.copy_selection", run: () => void calls.push("selection") },
        ...(exactSpace ? [{ bind: "space", run: () => void calls.push("space") }] : []),
      ],
    }))
    Keymap.createLayer(() => ({
      mode: "global",
      bindings: ["input.move.down", "session.new", "session.copy_mode", "prompt.copy_selection"],
    }))
    return <box />
  }

  return testRender(
    () => (
      <Keymap.Provider config={resolve(input, { terminalSuspend: true })}>
        <Harness />
      </Keymap.Provider>
    ),
    { kittyKeyboard: true },
  ).then((app) => ({ app, calls, keymap: () => keymap }))
}

test("copy mode default only runs in Vim normal mode", async () => {
  const fixture = await render({})
  try {
    fixture.keymap().vim.set("insert")
    fixture.app.mockInput.pressKey("x", { ctrl: true })
    fixture.app.mockInput.pressKey("v")
    fixture.keymap().vim.set("normal")
    fixture.app.mockInput.pressKey("x", { ctrl: true })
    fixture.app.mockInput.pressKey("v")

    expect(fixture.calls).toEqual(["copy"])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("prompt copy-selection default only runs in Vim normal mode", async () => {
  const fixture = await render({})
  try {
    fixture.keymap().vim.set("insert")
    fixture.app.mockInput.pressKey("x", { ctrl: true })
    fixture.app.mockInput.pressKey("y")
    fixture.keymap().vim.set("normal")
    fixture.app.mockInput.pressKey("x", { ctrl: true })
    fixture.app.mockInput.pressKey("y")

    expect(fixture.calls).toEqual(["selection"])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("Vim normal scoped bindings only run in normal mode", async () => {
  const fixture = await render({
    keybinds: { "input.move.down": "none", "vim.normal": { "input.move.down": "j" } },
  })
  try {
    fixture.keymap().vim.set("insert")
    fixture.app.mockInput.pressKey("j")
    fixture.keymap().vim.set("normal")
    fixture.app.mockInput.pressKey("j")

    expect(fixture.calls).toEqual(["down"])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("Vim normal leader only starts leader sequences in normal mode", async () => {
  const fixture = await render({ keybinds: { "vim.normal": { leader: "space" }, "session.new": "<leader>n" } })
  try {
    fixture.keymap().vim.set("insert")
    fixture.app.mockInput.pressKey(" ")
    fixture.app.mockInput.pressKey("n")
    fixture.app.mockInput.pressKey("x", { ctrl: true })
    fixture.app.mockInput.pressKey("n")

    fixture.keymap().vim.set("normal")
    fixture.app.mockInput.pressKey(" ")
    fixture.app.mockInput.pressKey("n")

    expect(fixture.calls).toEqual(["new"])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("Vim normal leader takes priority over an exact leader-key binding", async () => {
  const fixture = await render(
    { keybinds: { "vim.normal": { leader: "space" }, "session.new": "<leader>n" } },
    true,
  )
  try {
    fixture.keymap().vim.set("insert")
    fixture.app.mockInput.pressKey(" ")
    fixture.keymap().vim.set("normal")
    fixture.app.mockInput.pressKey(" ")
    fixture.app.mockInput.pressKey("n")

    expect(fixture.calls).toEqual(["space", "new"])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("global and Vim normal leaders can coexist", async () => {
  const fixture = await render({
    keybinds: { leader: "ctrl+x", "vim.normal": { leader: "space" }, "session.new": "<leader>n" },
  })
  try {
    fixture.keymap().vim.set("insert")
    fixture.app.mockInput.pressKey("x", { ctrl: true })
    fixture.app.mockInput.pressKey("n")
    fixture.app.mockInput.pressKey(" ")
    fixture.app.mockInput.pressKey("n")

    fixture.keymap().vim.set("normal")
    fixture.app.mockInput.pressKey(" ")
    fixture.app.mockInput.pressKey("n")

    expect(fixture.calls).toEqual(["new", "new"])
  } finally {
    fixture.app.renderer.destroy()
  }
})
