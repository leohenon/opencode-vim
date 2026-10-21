/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Skill } from "@opencode/schema/skill"
import { onMount } from "solid-js"
import { usePromptVim } from "../../../src/component/prompt/vim"
import { promptSnapshotDataEqual } from "../../../src/component/prompt/snapshot"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import type { PromptInfo } from "../../../src/prompt/history"
import { ToastProvider } from "../../../src/ui/toast"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

function event(name: string, ctrl = false) {
  return { name, ctrl, preventDefault() {} }
}

test("prompt copy selection writes the selected text to the clipboard", async () => {
  let textarea!: TextareaRenderable
  let copy!: ReturnType<typeof usePromptVim>["copyPromptSelection"]
  const writes: string[] = []

  function Harness() {
    const integration = usePromptVim({
      textarea: () => textarea,
      mode: () => "normal",
      submit() {},
      autocomplete: () => false,
      snapshot: () => ({ text: textarea.plainText, cursor: textarea.cursorOffset }),
      snapshotDataEqual: (left, right) => Bun.deepEquals(left, right),
      restore() {},
    })
    copy = integration.copyPromptSelection
    return <textarea initialValue="copy this text" ref={(value) => (textarea = value)} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts clipboard={{ read: async () => undefined, write: async (text) => void writes.push(text) }}>
        <ConfigProvider config={createTuiResolvedConfig({ vim: true, vim_initial_mode: "normal" })}>
          <Keymap.Provider>
            <ToastProvider>
              <Harness />
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { kittyKeyboard: true },
  )
  try {
    textarea.editorView.setSelection(0, 4)
    expect(await copy()).toBe(true)
    expect(writes).toEqual(["copy"])
  } finally {
    app.renderer.destroy()
  }
})

test("prompt Vim undo and redo restore complete PromptInfo snapshots", async () => {
  const before: PromptInfo = {
    text: "@a.ts @build @review [Pasted]",
    files: [{ uri: "file:///a.ts", name: "a.ts", mention: { start: 0, end: 5, text: "@a.ts" } }],
    agents: [{ name: "build", mention: { start: 6, end: 12, text: "@build" } }],
    skills: [{ id: Skill.ID.make("review"), mention: { start: 13, end: 20, text: "@review" } }],
    pasted: [{ text: "expanded", source: { start: 21, end: 29, text: "[Pasted]" } }],
  }
  const after: PromptInfo = {
    ...structuredClone(before),
    text: `${before.text}!`,
    files: [...(before.files ?? []), { uri: "file:///b.ts", name: "b.ts" }],
    agents: [...(before.agents ?? []), { name: "plan" }],
    skills: [...(before.skills ?? []), { id: Skill.ID.make("test") }],
    pasted: [...before.pasted, { text: "more", source: { start: 30, end: 38, text: "[Pasted]" } }],
  }
  let textarea!: TextareaRenderable
  let prompt = structuredClone(before)
  let vim!: ReturnType<typeof usePromptVim>["vim"]

  function Harness() {
    const integration = usePromptVim({
      textarea: () => textarea,
      mode: () => "normal",
      submit() {},
      autocomplete: () => false,
      snapshot: () => ({ text: textarea.plainText, cursor: textarea.cursorOffset, data: structuredClone(prompt) }),
      snapshotDataEqual: promptSnapshotDataEqual,
      restore(next) {
        textarea.setText(next.text)
        textarea.cursorOffset = next.cursor
        prompt = structuredClone(next.data as PromptInfo)
      },
    })
    vim = integration.vim
    onMount(() => {
      textarea.cursorOffset = textarea.plainText.length
    })
    return <textarea initialValue={before.text} ref={(value) => (textarea = value)} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ vim: true, vim_initial_mode: "normal" })}>
          <Keymap.Provider>
            <ToastProvider>
              <Harness />
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { kittyKeyboard: true },
  )
  try {
    // Prompt modes persist across mounts; establish the normal-mode precondition even in the full suite.
    vim.handleKey(event("escape"))
    textarea.cursorOffset = before.text.length
    vim.handleKey(event("i"))
    textarea.insertText("!")
    prompt = structuredClone(after)
    vim.handleKey(event("escape"))

    vim.handleKey(event("u"))
    expect(textarea.plainText).toBe(before.text)
    expect(prompt).toEqual(before)

    vim.handleKey(event("r", true))
    expect(textarea.plainText).toBe(after.text)
    expect(prompt).toEqual(after)

    vim.handleKey(event("."))
    expect(textarea.plainText).toBe(after.text)
    expect(prompt).toEqual(after)
  } finally {
    app.renderer.destroy()
  }
})
