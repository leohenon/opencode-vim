import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"

const fixture = () =>
  createAppFixture({
    width: 100,
    height: 30,
    config: { animations: false, vim: { enabled: true } } as any,
  })

test("prompt inserts spaces in vim insert mode", async () => {
  await using setup = await fixture()
  try {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("-- INSERT --"))
    setup.mockInput.pressKey("a")
    setup.mockInput.pressKey(" ")
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("a b")
  } finally {
    setup.renderer.destroy()
  }
})

test("prompt shows the vim mode and inserts spaces after re-entering insert mode", async () => {
  await using setup = await fixture()
  try {
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("-- INSERT --"))
    setup.mockInput.pressKey("a")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("a")

    // Normal mode is announced, so the prompt never looks like a text field
    // that silently drops keys.
    setup.mockInput.pressEscape()
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("-- NORMAL --")
    expect(setup.captureCharFrame()).not.toContain("-- INSERT --")

    setup.mockInput.pressKey("i")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("-- INSERT --")

    setup.mockInput.pressKey(" ")
    setup.mockInput.pressKey("b")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("a b")
  } finally {
    setup.renderer.destroy()
  }
})
