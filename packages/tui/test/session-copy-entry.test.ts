import { expect, test } from "bun:test"
import { toggleSessionCopyMode } from "../src/routes/session"

test("session scope enters copy mode when a form or permission replaces the prompt", () => {
  const calls: string[] = []
  toggleSessionCopyMode({
    copy: {
      active: () => false,
      enter: () => calls.push("enter"),
      exit: () => calls.push("exit"),
    },
    setVimMode: (mode) => calls.push(mode),
  })
  expect(calls).toEqual(["copy", "enter"])
})

test("session scope preserves mounted prompt Vim integration", () => {
  const calls: string[] = []
  toggleSessionCopyMode({
    copy: {
      active: () => false,
      enter: () => calls.push("fallback"),
      exit: () => calls.push("exit"),
    },
    prompt: { enterCopyMode: () => (calls.push("prompt"), true) },
    setVimMode: (mode) => calls.push(mode),
  })
  expect(calls).toEqual(["prompt"])
})
