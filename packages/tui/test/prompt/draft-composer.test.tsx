import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { saveDraft, takeDraft } from "../../src/component/prompt/draft-stash"
import { emptyPrompt, type PromptInfo } from "../../src/prompt/history"
import { createAppFixture } from "../fixture/app"
import { directory, json } from "../fixture/tui-client"

async function fixture(sessionID: string) {
  const shells: string[] = []
  const prompts: unknown[] = []
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  const session = {
    id: sessionID,
    title: "Draft fixture",
    agent: "build",
    model: { providerID: "demo", id: "model" },
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const app = await createAppFixture({
    args: { sessionID },
    config: {
      animations: false,
      vim: true,
      vim_initial_mode: "normal",
      tabs: { mode: "off" },
      keybinds: { "session.copy_mode": "f6", "prompt.stash.pop": "f8", "agent.list": "f9" },
    },
    fetch: async (url, request) => {
      if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
      if (url.pathname === `/api/session/${sessionID}/message`)
        return json({
          data: [{ type: "user", id: "draft_user", text: "Draft transcript marker", time: { created: 0 } }],
          cursor: {},
        })
      if (url.pathname === `/api/session/${sessionID}/inbox`) return json({ data: [] })
      if (url.pathname === "/api/fs/find") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
      if (url.pathname === `/api/session/${sessionID}/shell`) {
        shells.push((await request.json()).command)
        return new Response(null, { status: 204 })
      }
      if (url.pathname === `/api/session/${sessionID}/prompt`) {
        prompts.push(await request.json())
        return new Response(null, { status: 204 })
      }
    },
  })
  await app.ready
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  await app.waitForFrame(
    (frame) => (frame.includes("Demo Model") || frame.includes("Shell")) && frame.includes("Draft transcript marker"),
  )
  const textarea = app.renderer.currentFocusedEditor as TextareaRenderable
  return { app, textarea, shells, prompts }
}

function richDraft(): PromptInfo {
  const text = "[Pasted ~3 lines] @file.txt"
  return {
    ...emptyPrompt(),
    text,
    pasted: [{ text: "first\nsecond\nthird", source: { start: 0, end: 16, text: "[Pasted ~3 lines]" } }],
    files: [{ uri: "file:///tmp/file.txt", mention: { start: 17, end: text.length, text: "@file.txt" } }],
  }
}

test("copy freeze restores draft parts, extmarks and cursor together after a native text change", async () => {
  const id = `ses_draft_${crypto.randomUUID()}`
  const prompt = richDraft()
  saveDraft(id, { prompt: structuredClone(prompt), cursor: 4 })
  const { app, textarea } = await fixture(id)
  try {
    // Vim remembers its last mode across component instances in this process.
    app.mockInput.pressKey("ESCAPE")
    textarea.cursorOffset = 4
    app.mockInput.pressKey("F6")
    await app.waitForFrame((frame) => frame.includes("COPY"))
    textarea.setText("unexpected native edit")
    await app.renderOnce()
    expect(textarea.plainText).toBe(prompt.text)
    expect(textarea.extmarks.getAll()).toHaveLength(2)
    expect(textarea.cursorOffset).toBe(4)
  } finally {
    await app[Symbol.asyncDispose]()
  }
  expect(takeDraft(id)?.prompt).toMatchObject(prompt)
})

test("stashing a draft in copy mode clears the composer and pop recovers its parts", async () => {
  const id = `ses_draft_${crypto.randomUUID()}`
  const prompt = richDraft()
  saveDraft(id, { prompt: structuredClone(prompt), cursor: 4 })
  const { app, textarea } = await fixture(id)
  try {
    app.mockInput.pressKey("ESCAPE")
    textarea.cursorOffset = 4
    app.mockInput.pressKey("F6")
    await app.waitForFrame((frame) => frame.includes("COPY"))
    app.mockInput.pressKey("p", { ctrl: true })
    await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("Stash prompt")
    app.mockInput.pressEnter()
    await app.waitFor(() => textarea.focused)
    await app.renderOnce()
    expect(textarea.plainText).toBe("")
    expect(textarea.extmarks.getAll()).toHaveLength(0)
    app.mockInput.pressKey("F8")
    await app.renderOnce()
    expect(textarea.plainText).toBe(prompt.text)
    expect(textarea.extmarks.getAll()).toHaveLength(2)
  } finally {
    await app[Symbol.asyncDispose]()
  }
  expect(takeDraft(id)?.prompt).toMatchObject(prompt)
})

test("a shell draft survives cleanup/remount and submits to shell rather than the model", async () => {
  const id = `ses_draft_${crypto.randomUUID()}`
  const first = await fixture(id)
  try {
    await first.app.mockInput.typeText("!echo draft")
    first.textarea.cursorOffset = 3
    await first.app.renderOnce()
    expect(first.app.captureCharFrame()).toContain("Shell")
  } finally {
    await first.app[Symbol.asyncDispose]()
  }
  const second = await fixture(id)
  try {
    expect(second.textarea.plainText).toBe("echo draft")
    expect(second.textarea.cursorOffset).toBe(3)
    expect(second.app.captureCharFrame()).toContain("Shell")
    // Shell's footer masks agent/catalog readiness. Select the fixture agent through
    // the real picker before submitting, rather than racing the initial fetch.
    second.app.mockInput.pressKey("F9")
    await second.app.waitForFrame((frame) => frame.includes("Select agent") && frame.includes("build"))
    second.app.mockInput.pressEnter()
    await second.app.waitFor(() => second.textarea.focused)
    expect(second.app.captureCharFrame()).toContain("Shell")
    second.app.mockInput.pressEnter()
    await second.app.waitFor(() => second.shells.length > 0 || second.prompts.length > 0)
    expect(second.shells).toEqual(["echo draft"])
    expect(second.prompts).toEqual([])
  } finally {
    await second.app[Symbol.asyncDispose]()
    takeDraft(id)
  }
})
