import { expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import type { SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import type { FormWithLocation } from "../src/context/data"
import { directory, json } from "./fixture/tui-client"
import { waitForHighlightedFrame } from "./fixture/frame"
import { takeDraft } from "../src/component/prompt/draft-stash"

const session = {
  id: "ses_copy_keyboard",
  title: "Copy keyboard",
  projectID: "proj_test",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const history: SessionMessageInfo[] = [
  { type: "user", id: "copy_user", text: "Keyboard transcript marker", time: { created: 0 } },
  {
    type: "assistant",
    id: "copy_assistant",
    agent: "build",
    model: { providerID: "fixture", id: "fixture" },
    time: { created: 1, completed: 2 },
    finish: "stop",
    content: [{ type: "text", text: "Alpha transcript line\nBeta transcript line\nGamma transcript marker" }],
  },
]
const walk = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(walk)]
type Fixture = Awaited<ReturnType<typeof createAppFixture>>

const formRequest = () =>
  ({
    id: `frm_copy_keyboard_${crypto.randomUUID()}`,
    sessionID: session.id,
    title: "Copy form marker",
    fields: [{ key: "answer", type: "string", title: "Answer", default: "Form draft marker" }],
  }) satisfies FormWithLocation

async function fixture(form = false) {
  // Each fixture is a fresh app; do not restore a prior rerun's in-memory draft.
  takeDraft(session.id)
  const request = formRequest()
  const setup = await createAppFixture({
    height: 38,
    config: {
      vim: true,
      vim_initial_mode: "normal",
      vim_modal_input: true,
      vim_system_clipboard_register: false,
      tabs: { enabled: false },
      session: { sidebar: "hide", verbosity: "low" },
      keybinds: form ? {} : { "session.copy_mode": "f6" },
    },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: history.toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/form`)
        return json({
          data: form ? [request] : [],
        })
    },
  })
  await setup.ready
  await waitForHighlightedFrame(
    setup,
    (frame) => frame.includes("Keyboard transcript marker") && frame.includes("Gamma transcript marker"),
  )
  return setup
}

// CopyOverlay's block cursor is an absolute 1x1 box with a text child, directly
// under the transcript row. Inspect the real render tree, not copy controller state.
function cursor(setup: Fixture) {
  return walk(setup.renderer.root).find(
    (node) =>
      node.width === 1 &&
      node.height === 1 &&
      node.getChildren().some((child) => "plainText" in child) &&
      !!node.parent &&
      (node.parent.id === "copy_user" || node.parent.id.startsWith("session-")),
  )
}

async function press(setup: Fixture, key: string) {
  if (key === "escape") setup.mockInput.pressEscape()
  else setup.mockInput.pressKey(key)
  await setup.waitForVisualIdle({ quietFrames: 3 })
}

async function checkMotions(setup: Fixture) {
  expect(cursor(setup), "copy entry must render the CopyOverlay cursor").toBeDefined()
  await press(setup, "g")
  await press(setup, "g")
  expect(cursor(setup)?.parent?.id, "gg must move to the first transcript row").toBe("copy_user")
  const top = cursor(setup)!
  const start = { x: top.x, y: top.y }
  await press(setup, "j")
  expect(cursor(setup)?.y, "j must reach copy mode, not the composer/form").toBe(start.y + 1)
  await press(setup, "k")
  expect(cursor(setup)?.y, "k must restore the transcript row").toBe(start.y)
  // gg includes the user bubble's blank top padding. Move onto its text before
  // checking horizontal motions, which intentionally clamp on empty rows.
  await press(setup, "j")
  const textX = cursor(setup)!.x
  await press(setup, "l")
  expect(cursor(setup)?.x).toBe(textX + 1)
  await press(setup, "h")
  expect(cursor(setup)?.x).toBe(textX)
  setup.mockInput.pressKey("g", { shift: true })
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(cursor(setup)?.y).toBeGreaterThan(start.y)
  await press(setup, "g")
  await press(setup, "g")
  expect(cursor(setup)?.y).toBe(start.y)
}

test("composer routes copy entry, gg/j/k/h/l/G and escape without editing the draft", async () => {
  await using setup = await fixture()
  await setup.waitForFrame((frame) => frame.includes("Gamma transcript marker"))
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
  const composer = setup.renderer.currentFocusedRenderable as TextareaRenderable
  // The fork retains the previous prompt mode across sessions and test fixtures.
  await press(setup, "escape")
  await press(setup, "i")
  await setup.mockInput.typeText("Composer draft marker")
  await press(setup, "escape")
  expect(composer.plainText).toBe("Composer draft marker")
  await press(setup, "F6")
  await checkMotions(setup)
  await press(setup, "escape")
  expect(cursor(setup)).toBeUndefined()
  expect(composer.plainText).toBe("Composer draft marker")
  expect(composer.focused).toBe(true)
}, 15000)

test("copy command binding remains available while a form replaces the composer", async () => {
  await using setup = await fixture(true)
  await setup.waitForFrame((frame) => frame.includes("Copy form marker"))
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
  await press(setup, "escape")
  const answer = setup.renderer.currentFocusedRenderable as TextareaRenderable
  expect(answer.plainText).toBe("Form draft marker")
  setup.mockInput.pressKey("x", { ctrl: true })
  await press(setup, "v")
  expect(cursor(setup), "default session.copy_mode binding must be global, including FORM_MODE").toBeDefined()
  await checkMotions(setup)
  await press(setup, "escape")
  expect(cursor(setup)).toBeUndefined()
  expect(answer.plainText).toBe("Form draft marker")
  expect(answer.focused).toBe(true)
}, 15000)

test("active copy mode dispatches motions after a form replaces the composer", async () => {
  await using setup = await fixture()
  await setup.waitForFrame((frame) => frame.includes("Gamma transcript marker"))
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
  await press(setup, "F6")
  expect(cursor(setup), "copy entry succeeds before FORM_MODE is mounted").toBeDefined()
  // Mount through the real event stream so missing global entry bindings cannot
  // mask a separate hidden-Prompt/form key-dispatch regression.
  setup.events.emit({
    id: "evt_copy_form",
    created: 3,
    location: { directory },
    type: "form.created",
    data: { form: formRequest() },
  })
  await setup.waitForFrame((frame) => frame.includes("Copy form marker"))
  const answer = walk(setup.renderer.root).find(
    (node) => node instanceof TextareaRenderable && node.traits.status === "ANSWER",
  )
  if (!(answer instanceof TextareaRenderable)) throw new Error("Expected mounted form answer input")
  expect(answer.plainText).toBe("Form draft marker")
  await checkMotions(setup)
  await press(setup, "escape")
  expect(cursor(setup)).toBeUndefined()
  expect(answer.plainText).toBe("Form draft marker")
  expect(answer.focused).toBe(true)
}, 15000)

test("held Ctrl-W navigation enters and exits copy mode from a normal form input", async () => {
  await using setup = await fixture(true)
  await setup.waitForFrame((frame) => frame.includes("Copy form marker"))
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
  await press(setup, "escape")
  const answer = setup.renderer.currentFocusedRenderable as TextareaRenderable
  const windowKey = async (name: string) => {
    setup.mockInput.pressKey("w", { ctrl: true })
    setup.mockInput.pressKey(name, { ctrl: true })
    await setup.waitForVisualIdle({ quietFrames: 3 })
  }
  await windowKey("k")
  await checkMotions(setup)
  await windowKey("j")
  expect(cursor(setup)).toBeUndefined()
  expect(answer.focused).toBe(true)
  await windowKey("w")
  expect(cursor(setup)).toBeDefined()
  await windowKey("w")
  expect(cursor(setup)).toBeUndefined()
  expect(answer.plainText).toBe("Form draft marker")
  expect(answer.focused).toBe(true)
}, 15000)

test("a dialog clears a pending copy motion without losing copy mode", async () => {
  await using setup = await fixture()
  await setup.waitForFrame((frame) => frame.includes("Gamma transcript marker"))
  await press(setup, "F6")
  setup.mockInput.pressKey("g", { shift: true })
  await setup.waitForVisualIdle({ quietFrames: 3 })
  const bottom = cursor(setup)?.parent?.id
  await press(setup, "g")
  setup.mockInput.pressKey("p", { ctrl: true })
  await setup.waitForFrame((frame) => frame.includes("Commands"))
  await press(setup, "escape")
  await press(setup, "escape")
  await press(setup, "g")
  expect(cursor(setup)?.parent?.id).toBe(bottom)
  await press(setup, "g")
  expect(cursor(setup)?.parent?.id).toBe("copy_user")
}, 15000)
