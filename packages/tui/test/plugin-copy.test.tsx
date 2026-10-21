/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { usePlugin } from "@opencode/plugin/tui"
import type { Context, CopySelection } from "@opencode/plugin/tui/context"
import { ConfigProvider, resolve } from "../src/config"
import { usePromptVim } from "../src/component/prompt/vim"
import { createCopyMode } from "../src/routes/session/copy-mode"
import { ToastProvider } from "../src/ui/toast"
import { TestTuiContexts } from "./fixture/tui-environment"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { Keymap } from "../src/context/keymap"
import { createPluginContext, type Dispose, type Registry, type usePluginHost } from "../src/plugin/api"
import { createSignal, Show, type JSX } from "solid-js"

const selection: CopySelection = {
  sessionID: "session",
  text: "selected excerpt",
  mode: "line",
  references: [{ messageID: "message", partID: "part", role: "assistant" }],
}

test("setup and scoped plugin contexts read the current copy provider without activation gating", async () => {
  let keymap!: Keymap
  let setup!: Context
  let scoped!: Context
  let current: CopySelection | undefined = selection
  const owned: Dispose[] = []
  function Scoped() {
    scoped = usePlugin()
    return <box />
  }
  function Harness() {
    keymap = Keymap.use()
    keymap.copy.register(() => current)
    let render!: () => JSX.Element
    const host = {
      app: {},
      client: {},
      keymap,
      shortcuts: {},
      keymapState: {},
      sessionTabs: {},
      dialog: {
        replace: (next: () => JSX.Element) => {
          render = next
        },
      },
    } as unknown as ReturnType<typeof usePluginHost>
    const registry: Registry = { has: () => false, set() {}, remove() {}, active: () => false }
    setup = createPluginContext({ host, id: "copy", options: undefined, owned, registry })
    expect(setup.copy.selection()).toEqual(selection)
    setup.ui.dialog.show(() => <Scoped />)
    return render()
  }
  const app = await testRender(
    () => (
      <Keymap.Provider config={resolve({}, { terminalSuspend: true })}>
        <Harness />
      </Keymap.Provider>
    ),
    { width: 80, height: 24 },
  )
  try {
    expect(scoped.copy.selection()).toEqual(selection)
    current = { ...selection, text: "changed" }
    expect(setup.copy.selection()?.text).toBe("changed")
    expect(scoped.copy.selection()?.text).toBe("changed")
    const release = keymap.copy.register(() => undefined)
    expect(setup.copy.selection()).toBeUndefined()
    expect(scoped.copy.selection()).toBeUndefined()
    release()
    for (const dispose of owned) await dispose()
  } finally {
    app.renderer.destroy()
  }
})

test("prompt selection bridge follows copy state and releases on prompt unmount", async () => {
  let keymap!: Keymap
  let prompt!: ReturnType<typeof usePromptVim>
  let textarea!: TextareaRenderable
  const [mounted, setMounted] = createSignal(true)
  const [current, setCurrent] = createSignal<CopySelection | undefined>(selection)
  const config = resolve({ vim: true }, { terminalSuspend: true })
  function Prompt() {
    const copy = createCopyMode({
      scroll: () => ({ getChildren: () => [] }) as unknown as ScrollBoxRenderable,
      targets: () => [],
      session: () => "session",
      toBottom() {},
      write: async () => {},
    })
    const adapter = { ...copy.prompt, selection: current }
    prompt = usePromptVim({
      textarea: () => textarea,
      mode: () => "normal",
      copy: () => adapter,
      submit() {},
      autocomplete: () => false,
      snapshot: () => ({ text: "", cursor: 0 }),
      snapshotDataEqual: () => true,
      restore() {},
    })
    return <textarea ref={textarea} />
  }
  function Harness() {
    keymap = Keymap.use()
    return (
      <Show when={mounted()}>
        <Prompt />
      </Show>
    )
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={config}>
          <ToastProvider>
            <Keymap.Provider>
              <Harness />
            </Keymap.Provider>
          </ToastProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24 },
  )
  try {
    expect(keymap.copy.selection()).toBeUndefined()
    prompt.vimState.setMode("copy")
    expect(keymap.copy.selection()).toEqual(selection)
    setCurrent({ ...selection, text: "moved cursor" })
    expect(keymap.copy.selection()?.text).toBe("moved cursor")
    prompt.vimState.setMode("normal")
    expect(keymap.copy.selection()).toBeUndefined()
    prompt.vimState.setMode("copy")
    setMounted(false)
    expect(keymap.copy.selection()).toBeUndefined()
    setMounted(true)
    prompt.vimState.setMode("copy")
    const release = keymap.copy.register(() => selection)
    setCurrent(undefined)
    prompt.vimState.setMode("normal")
    expect(keymap.copy.selection()).toEqual(selection)
    setMounted(false)
    expect(keymap.copy.selection()).toEqual(selection)
    release()
    expect(keymap.copy.selection()).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("copy providers resolve dynamically, release only their own registration, and clear on teardown", async () => {
  let keymap!: Keymap
  function Harness() {
    keymap = Keymap.use()
    return <box />
  }
  const app = await testRender(
    () => (
      <Keymap.Provider config={resolve({}, { terminalSuspend: true })}>
        <Harness />
      </Keymap.Provider>
    ),
    { width: 80, height: 24 },
  )
  try {
    expect(keymap.copy.selection()).toBeUndefined()
    const provider = () => selection
    const first = keymap.copy.register(provider)
    expect(keymap.copy.selection()).toEqual(selection)
    const second = keymap.copy.register(() => ({ ...selection, text: "second" }))
    first()
    expect(keymap.copy.selection()?.text).toBe("second")
    second()
    expect(keymap.copy.selection()).toBeUndefined()
    keymap.copy.register(provider)
    first() // An already released disposer cannot remove a later registration of the same callback.
    expect(keymap.copy.selection()).toEqual(selection)
  } finally {
    app.renderer.destroy()
  }
  expect(keymap.copy.selection()).toBeUndefined()
})
