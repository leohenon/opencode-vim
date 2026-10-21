/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup, Show } from "solid-js"
import type { Keymap } from "../../../src/context/keymap"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import type { TuiKeybind } from "../../../src/config/keybind"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountPrompt(input: {
  root: string
  keybinds: Partial<TuiKeybind.Keybinds>
  config?: {
    vim?: boolean
    vim_modal_input?: boolean
    vim_escape_sequence?: string
    vim_langmap?: Record<string, string>
  }
  onConfirm: (value: string) => void
}) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })

  const [{ DialogProvider }, { DialogPrompt }, { ThemeProvider }, { ConfigProvider }, { ToastProvider }, { Keymap }] =
    await Promise.all([
      import("../../../src/ui/dialog"),
      import("../../../src/ui/dialog-prompt"),
      import("../../../src/context/theme"),
      import("../../../src/config"),
      import("../../../src/ui/toast"),
      import("../../../src/context/keymap"),
    ])

  const [shown, setShown] = createSignal(true)
  let keymap!: Keymap
  function Capture() {
    keymap = Keymap.use()
    return null
  }

  function Harness() {
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: input.keybinds,
      leader: { timeout: 1000 },
      ...input.config,
    })

    function Prompt() {
      onCleanup(Keymap.use().mode.push("modal"))
      return <DialogPrompt title="Rename Session" value="draft" onConfirm={input.onConfirm} />
    }

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <ConfigProvider config={resolvedConfig}>
          <Keymap.Provider>
            <Capture />
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Show when={shown()}>
                    <Prompt />
                  </Show>
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  app.renderer.start()
  return {
    app,
    keymap: () => keymap,
    unmount: () => setShown(false),
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("disposing a modal prompt cannot restore a snapshot over a newer copy owner", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: {},
    config: { vim: true, vim_modal_input: true },
    onConfirm: () => {},
  })
  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    prompt.app.mockInput.pressEscape()
    expect(prompt.keymap().vim.current()).toBe("normal")
    prompt.keymap().vim.set("copy")
    prompt.unmount()
    expect(prompt.keymap().vim.current()).toBe("copy")
  } finally {
    await prompt.cleanup()
  }
})

test("dialog prompt submit wins when return is also input newline", async () => {
  await using tmp = await tmpdir()
  const confirmed: string[] = []
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: {
      "input.submit": "super+return",
      "input.newline": "return,shift+return,alt+return,ctrl+j",
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pressEnter()

    expect(confirmed).toEqual(["draft"])
    expect(textarea.plainText).toBe("draft")
  } finally {
    await prompt.cleanup()
  }
})

test("dialog prompt enters normal mode and handles Vim motions", async () => {
  await using tmp = await tmpdir()
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: {},
    config: { vim: true, vim_modal_input: true },
    onConfirm: () => {},
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    expect(textarea.cursorOffset).toBe(5)
    prompt.app.mockInput.pressEscape()
    expect(textarea.cursorOffset).toBe(4)

    prompt.app.mockInput.pressKey("h")
    expect(textarea.cursorOffset).toBe(3)
    expect(textarea.plainText).toBe("draft")
  } finally {
    await prompt.cleanup()
  }
})

test.each([
  { name: "modal input is disabled", config: { vim: true, vim_modal_input: false } },
  { name: "Vim is disabled globally", config: { vim: false, vim_modal_input: true } },
])("dialog prompt keeps non-Vim behavior when $name", async ({ config }) => {
  await using tmp = await tmpdir()
  const prompt = await mountPrompt({ root: tmp.path, keybinds: {}, config, onConfirm: () => {} })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pressKey("h")
    expect(textarea.plainText).toBe("drafth")
  } finally {
    await prompt.cleanup()
  }
})

test("alt return inserts a newline with default keybinds", async () => {
  await using tmp = await tmpdir()
  const confirmed: string[] = []
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: {},
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pressEnter({ meta: true })

    expect(confirmed).toEqual([])
    expect(textarea.plainText).toBe("draft\n")
  } finally {
    await prompt.cleanup()
  }
})

test("dialog prompt submit can be rebound separately from input submit", async () => {
  await using tmp = await tmpdir()
  const confirmed: string[] = []
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: {
      "input.submit": "return",
      "dialog.prompt.submit": "ctrl+y",
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pressEnter()
    expect(confirmed).toEqual([])
    expect(textarea.plainText).toBe("draft")

    prompt.app.mockInput.pressKey("y", { ctrl: true })

    expect(confirmed).toEqual(["draft"])
  } finally {
    await prompt.cleanup()
  }
})

test("dialog prompt submit can be disabled", async () => {
  await using tmp = await tmpdir()
  const confirmed: string[] = []
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: {
      "input.submit": "return",
      "dialog.prompt.submit": "none",
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pressEnter()

    expect(confirmed).toEqual([])
    expect(textarea.plainText).toBe("draft")
  } finally {
    await prompt.cleanup()
  }
})
