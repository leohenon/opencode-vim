import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { migrateV1, parseThemeDocument, resolveTheme, resolveThemeDocument } from "../src/tui/index.js"
import type { Mode, ResolvedTheme } from "../src/tui/index.js"
import type { ThemeV1Json } from "../src/tui/v1.js"

const builtin: ThemeV1Json = await Bun.file(new URL("../../tui/src/theme/assets/opencode.json", import.meta.url)).json()
const vesper: ThemeV1Json = await Bun.file(new URL("../../tui/src/theme/assets/vesper.json", import.meta.url)).json()
const modes: Mode[] = ["light", "dark"]
const roles = ["base", "search", "current"] as const

function visible(theme: ResolvedTheme) {
  for (const role of roles) {
    const foreground = theme.text.selection[role]
    const background = theme.background.selection[role]
    expect(foreground.a).toBe(1)
    expect(background.a).toBe(1)
    expect(background.equals(theme.background.base)).toBeFalse()
    expect(foreground.equals(background)).toBeFalse()
  }
  expect(theme.background.action.primary.base.a).toBe(0)
}

function legacy() {
  // Old V2 documents have all existing required fields but no selection role.
  return parseThemeDocument(
    JSON.parse(JSON.stringify(migrateV1(builtin), (key, value) => (key === "selection" ? undefined : value))),
  )
}

test.each(modes)("builtin %s migration preserves fork selection colors", (mode) => {
  const theme = resolveThemeDocument(migrateV1(builtin), mode)
  const expected =
    mode === "dark"
      ? { base: "#5c9cf5", search: "#808080", current: "#fab283", text: "#0a0a0a" }
      : { base: "#7b5bb6", search: "#8a8a8a", current: "#3b7dd8", text: "#ffffff" }
  for (const role of roles) {
    expect(theme.background.selection[role].equals(RGBA.fromHex(expected[role]))).toBeTrue()
    expect(theme.text.selection[role].equals(RGBA.fromHex(expected.text))).toBeTrue()
  }
  visible(theme)
  visible(theme.surface("dialog"))
})

test.each(modes)("Vesper %s has visible migrated selections", (mode) => {
  const theme = resolveThemeDocument(parseThemeDocument(migrateV1(vesper)), mode)
  for (const [role, color] of [
    ["base", "#99ffe4"],
    ["search", "#a0a0a0"],
    ["current", "#ffc799"],
  ] as const) {
    expect(theme.background.selection[role].equals(RGBA.fromHex(color))).toBeTrue()
    expect(theme.text.selection[role].equals(RGBA.fromHex(mode === "dark" ? "#101010" : "#ffffff"))).toBeTrue()
  }
  visible(theme)
  visible(theme.surface("dialog"))
})

test("V1 selection foregrounds are chosen for each background", () => {
  const theme = resolveThemeDocument(
    migrateV1({
      ...builtin,
      theme: {
        ...builtin.theme,
        background: "transparent",
        secondary: "#ffffff",
        textMuted: "#ffffff",
        primary: "#000000",
      },
    }),
    "dark",
  )
  expect(theme.text.selection.base.equals(RGBA.fromHex("#000000"))).toBeTrue()
  expect(theme.text.selection.search.equals(RGBA.fromHex("#000000"))).toBeTrue()
  expect(theme.text.selection.current.equals(RGBA.fromHex("#ffffff"))).toBeTrue()
})

test("V1 selection honors an explicit selected foreground", () => {
  const theme = resolveThemeDocument(
    migrateV1({
      ...builtin,
      theme: { ...builtin.theme, selectedListItemText: "#123456" },
    }),
    "dark",
  )
  for (const role of roles) expect(theme.text.selection[role].equals(RGBA.fromHex("#123456"))).toBeTrue()
})

test.each(modes)("legacy V2 %s documents receive contextual selection defaults", (mode) => {
  const document = legacy()
  expect(document.base.text.selection).toBeUndefined()
  const theme = resolveThemeDocument(document, mode)
  for (const view of [theme, theme.surface("dialog")]) {
    for (const role of roles) expect(view.text.selection[role].equals(view.background.base)).toBeTrue()
    expect(view.background.selection.base).toBe(view.hue.interactive[200])
    expect(view.background.selection.current).toBe(view.hue.interactive[200])
    expect(view.background.selection.search).toBe(view.hue.neutral[400])
    visible(view)
  }
})

test.each(modes)("partial V2 %s selections inherit parent fields before defaults", (mode) => {
  const document = legacy()
  const theme = resolveThemeDocument(
    parseThemeDocument({
      ...document,
      base: {
        ...document.base,
        text: { ...document.base.text, selection: { base: "#112233", search: "$text.base" } },
        background: { ...document.base.background, selection: { base: "#445566", search: "#778899" } },
        "@dialog": {
          text: { selection: { current: "#abcdef" } },
          background: { base: "#121212", selection: { current: "$background.selection.base" } },
        },
      },
      [mode]: {
        ...document[mode],
        text: { selection: { base: "#223344" } },
        background: { selection: { search: "#8899aa" } },
      },
    }),
    mode,
  )
  const dialog = theme.surface("dialog")
  for (const view of [theme, dialog]) {
    expect(view.text.selection.base.equals(RGBA.fromHex("#223344"))).toBeTrue()
    expect(view.text.selection.search.equals(view.text.base)).toBeTrue()
    expect(view.background.selection.base.equals(RGBA.fromHex("#445566"))).toBeTrue()
    expect(view.background.selection.search.equals(RGBA.fromHex("#8899aa"))).toBeTrue()
  }
  expect(theme.text.selection.current.equals(theme.background.base)).toBeTrue()
  expect(theme.background.selection.current).toBe(theme.hue.interactive[200])
  expect(dialog.text.selection.current.equals(RGBA.fromHex("#abcdef"))).toBeTrue()
  expect(dialog.background.selection.current.equals(dialog.background.selection.base)).toBeTrue()
})

test("complete theme definitions accept partial selection fields", () => {
  const document = legacy()
  const theme = resolveTheme({
    ...document.base,
    hue: document.dark!.hue,
    text: { ...document.base.text, selection: { search: "#abcdef" } },
    background: { ...document.base.background, selection: { current: "$background.selection.search" } },
  })
  expect(theme.text.selection.search.equals(RGBA.fromHex("#abcdef"))).toBeTrue()
  expect(theme.text.selection.base.equals(theme.background.base)).toBeTrue()
  expect(theme.background.selection.current).toBe(theme.hue.neutral[400])
})
