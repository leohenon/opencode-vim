import { expect, test } from "bun:test"
import { createStorage } from "../src/context/storage"
import { createUIState } from "../src/context/ui-state"
import { tmpdir } from "./fixture/fixture"

test("minimal UI and Vim overrides persist in TUI-local storage", async () => {
  await using directory = await tmpdir()
  const first = createStorage(directory.path, "test")
  const [state, update] = createUIState(first.storage)

  await update((draft) => {
    draft.minimal = true
    draft.vim = false
  })
  expect({ ...state }).toEqual({ minimal: true, vim: false })
  first.close()

  const second = createStorage(directory.path, "test")
  try {
    expect({ ...createUIState(second.storage)[0] }).toEqual({ minimal: true, vim: false })
  } finally {
    second.close()
  }
})
